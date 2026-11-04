import { app } from 'electron'
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPaths } from './paths'
import type { JaisVariantId } from '../../shared/types'

export type EngineMode = 'managed' | 'existing'

/**
 * Marker written when the engine is ready. `managed` means the app built its
 * own venv and downloaded the weights; `existing` means it borrowed a Python
 * environment and a Jais-ASR folder that were already on this PC.
 */
export interface EngineMarker {
  completed: boolean
  updatedAt: string
  mode?: EngineMode
  python?: string
  jaisDir?: string
  probe?: Record<string, unknown>
}

export function readMarker(): EngineMarker | null {
  const parsed = readMarkerRaw()
  if (!parsed || typeof parsed !== 'object' || !parsed.completed) return null
  return parsed
}

/** Marker contents even when setup never completed (used for state snapshots). */
export function readMarkerRaw(): EngineMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(getPaths().setup, 'utf8')) as EngineMarker
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/** Point Jais-ASR at a folder the user already has, keeping the engine marker. */
export function setJaisDir(dir?: string): void {
  const current = readMarkerRaw()
  // Nothing recorded and nothing to record: do not create a marker file just
  // to say "no override", or a failed download could leave setup half-written.
  if (!current && !dir) return
  const next: EngineMarker = {
    completed: current?.completed ?? false,
    updatedAt: new Date().toISOString(),
    mode: current?.mode,
    python: current?.python,
    probe: current?.probe,
    jaisDir: dir || undefined
  }
  if (current?.completed) writeMarker(next)
  else writeMarker({ ...next, completed: false })
}

export function jaisIsCustom(): boolean {
  const marker = readMarkerRaw()
  return Boolean(marker?.jaisDir)
}

export function writeMarker(marker: EngineMarker): void {
  const file = getPaths().setup
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(marker, null, 2), 'utf8')
  renameSync(tmp, file)
}

export function isExisting(): boolean {
  return readMarker()?.mode === 'existing'
}

export function enginePython(): string {
  const marker = readMarker()
  // A borrowed interpreter can disappear (uninstalled Python, deleted venv).
  // Trust the marker only while the file is still there, otherwise fall back
  // to the managed venv instead of failing every job with a bare ENOENT.
  if (marker?.mode === 'existing' && marker.python && existsSync(marker.python)) {
    return marker.python
  }
  return getPaths().python
}

export function engineJaisDir(): string {
  const marker = readMarkerRaw()
  if (marker?.jaisDir) return marker.jaisDir
  return getPaths().jais
}

export function jaisComplete(dir: string): boolean {
  if (!dir) return false
  return ggufPair(dir)
}

export type { JaisVariantId }

/**
 * The GGUF quants published in https://huggingface.co/IFM/Jais-ASR-GGUF that
 * llama.cpp can run on this PC.
 */
export const JAIS_VARIANTS: Record<
  JaisVariantId,
  { repo: string; label: string; bytes: number; wer: number; vramGb: number; files?: string[] }
> = {
  gguf: {
    repo: 'IFM/Jais-ASR-GGUF',
    label: 'Jais-ASR Q4_K_M (GGUF)',
    bytes: 3_712_101_824,
    wer: 22.99,
    vramGb: 5.5,
    files: ['Jais-ASR-Q4_K_M.gguf', 'mmproj-Jais-ASR-Q6_K.gguf']
  },
  'gguf-q8': {
    repo: 'IFM/Jais-ASR-GGUF',
    label: 'Jais-ASR Q8_0 (GGUF)',
    bytes: 6_714_641_344,
    wer: 22.83,
    vramGb: 7.6,
    files: ['Jais-ASR-Q8_0.gguf', 'mmproj-Jais-ASR-F16.gguf']
  }
}

/** llama-server ships beside the app; GGUF weights are unusable without it. */
export function llamaServerPath(): string | null {
  const explicit = process.env.TAFREEGH_LLAMA_SERVER
  if (explicit && existsSync(explicit)) return explicit
  // An explicit directory is exclusive: pointing it at an empty folder is how
  // the CPU-only path is exercised, so never fall back to the bundled build.
  const override = process.env.TAFREEGH_LLAMA_DIR
  const roots = (override
    ? [override]
    : [
        process.resourcesPath ? join(process.resourcesPath, 'llama') : undefined,
        join(app.getAppPath(), 'resources', 'llama')
      ]
  ).filter(Boolean) as string[]
  for (const root of roots) {
    const candidate = join(root, 'llama-server.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Which acceleration the bundled llama.cpp was built with, read from the
 * `backend.txt` marker that ships beside llama-server.exe (DLL sniffing is the
 * fallback for older bundles).
 */
export function llamaBackend(): 'cpu' | 'vulkan' | 'cuda' | null {
  const server = llamaServerPath()
  if (!server) return null
  const root = dirname(server)
  try {
    const marker = readFileSync(join(root, 'backend.txt'), 'utf8').trim().toLowerCase()
    if (marker === 'cpu' || marker === 'vulkan' || marker === 'cuda') return marker
  } catch {
    // fall through to DLL sniffing
  }
  if (existsSync(join(root, 'ggml-cuda.dll'))) return 'cuda'
  if (existsSync(join(root, 'ggml-vulkan.dll'))) return 'vulkan'
  return 'cpu'
}

function ggufPair(dir: string): boolean {
  try {
    const names = readdirSync(dir).map((name) => name.toLowerCase())
    return (
      names.some((name) => name.endsWith('.gguf') && !name.startsWith('mmproj')) &&
      names.some((name) => name.startsWith('mmproj') && name.endsWith('.gguf'))
    )
  } catch {
    return false
  }
}

/**
 * The text model llama-server will actually load. Mirrors
 * `jais_gguf.gguf_files()`: the Q4_K_M file wins when several quants share the
 * folder, otherwise the sorted first one — otherwise the app reports Q8 while
 * the runtime loads Q4.
 */
function ggufModelName(dir: string): string | null {
  try {
    const names = readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.gguf') && !name.toLowerCase().startsWith('mmproj'))
      .sort()
    return names.find((name) => name === 'Jais-ASR-Q4_K_M.gguf') ?? names[0] ?? null
  } catch {
    return null
  }
}

/** Which GGUF quant sits in this folder, or null when there is no usable pair. */
export function jaisVariant(dir: string): JaisVariantId | null {
  if (!ggufPair(dir)) return null
  const model = ggufModelName(dir)
  return model && model.toLowerCase().includes('q8_0') ? 'gguf-q8' : 'gguf'
}

/**
 * Both GGUF quants run through llama.cpp. Q8_0 needs ~7.6 GB resident, so it is
 * only picked from 9 GB of VRAM up; everything else gets Q4_K_M.
 */
export function selectJaisVariant(vramMb?: number): JaisVariantId {
  const forced = process.env.TAFREEGH_JAIS_VARIANT
  if (forced && Object.hasOwn(JAIS_VARIANTS, forced)) return forced as JaisVariantId
  return (vramMb ?? 0) >= 9 * 1024 ? 'gguf-q8' : 'gguf'
}

export function nemoCacheDirs(): string[] {
  // The app-owned cache (NEMO_SPEECH_MODEL_DIR) comes first: new downloads land
  // there. The shared folders are still scanned so an upgrade notices weights
  // downloaded by older builds.
  const dirs: string[] = [join(getPaths().models, 'nemo-diarization')]
  if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'NeMoSpeech', 'models'))
  const home = app.getPath('home')
  dirs.push(join(home, '.cache', 'NeMoSpeech', 'models'))
  dirs.push(join(home, '.cache', 'nemo-speech', 'models'))
  return dirs
}

export function dirSize(path: string): number {
  if (!existsSync(path)) return 0
  let total = 0
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) total += dirSize(full)
      else if (entry.isFile()) {
        try {
          total += statSync(full).size
        } catch {
          // a file can vanish mid-walk; keep the partial total
        }
      }
    }
  } catch {
    // unreadable folder: report what we have
  }
  return total
}

export function nemoBytes(): number {
  return nemoCacheDirs().reduce((total, dir) => total + dirSize(dir), 0)
}
