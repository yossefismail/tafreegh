import { app } from 'electron'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

export const MOCK = process.env.TAFREEGH_MOCK === '1'

export interface AppPaths {
  root: string
  jobs: string
  logs: string
  runtime: string
  venv: string
  python: string
  uv: string
  uvPython: string
  models: string
  jais: string
  backend: string
  worker: string
  history: string
  settings: string
  secrets: string
  setup: string
}

export function resolveDataRoot(): string {
  if (process.env.TAFREEGH_DATA_DIR) return process.env.TAFREEGH_DATA_DIR
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'Tafreegh')
  }
  return app.getPath('userData')
}

let cached: AppPaths | null = null

export function getPaths(): AppPaths {
  if (cached) return cached
  const root = resolveDataRoot()
  const runtime = join(root, 'runtime')
  const venv = join(runtime, 'venv')
  const isWin = process.platform === 'win32'
  const py = isWin
    ? join(venv, 'Scripts', 'python.exe')
    : join(venv, 'bin', 'python')
  const backend = app.isPackaged
    ? join(process.resourcesPath, 'backend')
    : join(app.getAppPath(), 'backend')
  cached = {
    root,
    jobs: join(root, 'jobs'),
    logs: join(root, 'logs'),
    runtime,
    venv,
    python: py,
    uv: join(runtime, 'uv', isWin ? 'uv.exe' : 'uv'),
    uvPython: join(runtime, 'python'),
    models: join(root, 'models'),
    jais: join(root, 'models', 'jais-asr'),
    backend,
    worker: join(backend, 'worker.py'),
    history: join(root, 'history.json'),
    settings: join(root, 'settings.json'),
    secrets: join(root, 'secrets.json'),
    setup: join(root, 'setup.json')
  }
  return cached
}

export function ensureDirs(): void {
  const p = getPaths()
  for (const dir of [p.root, p.jobs, p.logs, p.runtime, p.models]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

export function jobDir(id: string): string {
  if (!/^[a-z0-9-]{8,64}$/i.test(id)) throw new Error('invalid job id')
  return join(getPaths().jobs, id)
}

/**
 * True when `target` is the root itself or lives under it. Uses `relative`
 * so `..` segments and different drives are rejected, and so Windows paths
 * compare case-insensitively (the default NTFS behaviour) instead of failing
 * the check for a legitimate folder typed with different capitalisation.
 */
export function isWithinRoot(root: string, target: string): boolean {
  if (!root || !target) return false
  const rel = relative(resolve(root), resolve(target))
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}
