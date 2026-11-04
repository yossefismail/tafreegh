import extract from 'extract-zip'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  createReadStream,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  promises as fsp,
  type Dirent
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  GpuInfo,
  ModelKind,
  SetupPhase,
  SetupProgress,
  SetupStatus
} from '../../shared/types'
import { downloadFile, downloadText } from './download'
import {
  dirSize,
  engineJaisDir,
  enginePython,
  jaisComplete,
  jaisVariant,
  JAIS_VARIANTS,
  llamaServerPath,
  nemoBytes,
  nemoCacheDirs,
  readMarker,
  readMarkerRaw,
  selectJaisVariant,
  setJaisDir,
  writeMarker,
  type EngineMarker,
  type JaisVariantId
} from './engine'
import {
  clearOverride,
  diarizerModel,
  readOverrides,
  writeOverrides
} from './models'
import { getPaths, MOCK } from './paths'
import { hfTokenEnv } from './hf'
import { ProcessRunner } from './process'
import { CancelledError, runWorker } from './worker'

const UV_VERSION = '0.13.6'
const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`
// Python 3.12 + the worker dependencies (numpy/scipy/soundfile/noisereduce/
// huggingface_hub). No PyTorch: enhancement is spectral, so the runtime is
// roughly 5 GB smaller than in 0.9.x betas before this one.
const RUNTIME_GB = 7

const LEGACY_DENOISER_DIR = 'resemble-enhance'

type EmitProgress = (progress: SetupProgress) => void

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '')
}

async function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Free space needed for the artifact we are about to fetch. The 5 GB floor is
 * a safety margin for the runtime; when there is nothing to download it must
 * not block a setup run on a nearly-full disk.
 */
export function requiredDiskGb(
  variant: JaisVariantId,
  includeRuntime: boolean,
  includeModel: boolean
): number {
  const runtime = includeRuntime ? RUNTIME_GB : 0
  const model = includeModel ? Math.ceil(JAIS_VARIANTS[variant].bytes / 1e9) : 0
  const floor = includeRuntime || includeModel ? 5 : 1
  return Math.max(floor, runtime + model + 2)
}

export interface LlamaDevice {
  id: string
  name: string
  vramMb?: number
}

/**
 * Parse `llama-server --list-devices`, e.g.
 *   Available devices:
 *     Vulkan0: AMD Radeon 740M Graphics (8330 MiB, 7913 MiB free)
 *     Vulkan1: NVIDIA GeForce RTX 4050 Laptop GPU (5920 MiB, 5152 MiB free)
 */
export function parseDeviceList(output: string): LlamaDevice[] {
  const devices: LlamaDevice[] = []
  for (const raw of output.split(/\r?\n/)) {
    const head = raw.match(/^\s*([A-Za-z]+\d+):\s*(.+?)\s*$/)
    if (!head) continue
    const vram = raw.match(/\((\d+)\s*MiB(?:\s*,\s*\d+\s*MiB free)?\)/)
    devices.push({
      id: head[1],
      name: head[2].replace(/\s*\(.*\)\s*$/, '').trim(),
      vramMb: vram ? Number(vram[1]) : undefined
    })
  }
  return devices
}

export class SetupService {
  private runner = new ProcessRunner()
  private gpuCache: { at: number; value: GpuInfo } | null = null
  private running = false
  private cancelled = false
  private abort = new AbortController()
  private lastLogAt = 0
  private cachedDisk: { at: number; value: number } | null = null
  private currentPhase: SetupPhase = 'check'
  /** Set once the interpreter is known to resume interrupted downloads. */
  private resumeReady = false

  /** Token supplier: read on each worker run so a newly saved token applies. */
  constructor(
    private emit: EmitProgress,
    private hfToken: () => string | undefined = () => undefined
  ) {}

  private hfEnv(): NodeJS.ProcessEnv {
    return hfTokenEnv(this.hfToken())
  }

  private progress(
    phase: SetupPhase,
    pct: number | null,
    message: string,
    indeterminate = false,
    extra: Partial<SetupProgress> = {}
  ): void {
    this.currentPhase = phase
    this.emit({
      phase,
      pct: pct ?? 0,
      indeterminate,
      message,
      ...extra
    })
  }

  private logLine(line: string): void {
    const now = Date.now()
    if (now - this.lastLogAt < 120) return
    this.lastLogAt = now
    const clean = stripAnsi(line).trim()
    if (!clean) return
    this.emit({
      phase: this.currentPhase,
      pct: 0,
      indeterminate: true,
      message: '',
      logLine: clean.slice(0, 240)
    })
  }

  async gpu(force = false): Promise<GpuInfo> {
    if (MOCK) {
      return {
        checked: true,
        available: true,
        name: 'Mock GPU (test mode)',
        vramMb: 6141,
        driver: 'mock',
        acceleration: 'cuda'
      }
    }
    if (!force && this.gpuCache && Date.now() - this.gpuCache.at < 15_000) {
      return this.gpuCache.value
    }
    // Ask the engine first: llama.cpp reports exactly the Vulkan/CUDA devices it
    // can use, including AMD cards that nvidia-smi knows nothing about.
    const accelerator = await this.llamaDevice()
    if (accelerator) {
      this.gpuCache = { at: Date.now(), value: accelerator }
      return accelerator
    }
    const runner = new ProcessRunner()
    try {
      const result = await runner.run(
        'nvidia-smi',
        ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
        { handlers: {}, timeoutMs: 15_000 }
      )
      const output = result.stdoutTail.trim().split('\n').find((l) => l.includes(',')) ?? ''
      if (result.code !== 0 || !output) throw new Error('nvidia-smi returned no GPU')
      const match = output.match(/^(.*),\s*(\d+),\s*([\d.]+)\s*$/)
      if (!match) throw new Error('could not parse nvidia-smi output')
      const value: GpuInfo = {
        checked: true,
        available: true,
        name: match[1].trim(),
        vramMb: Number(match[2]),
        driver: match[3],
        acceleration: 'cuda'
      }
      this.gpuCache = { at: Date.now(), value }
      return value
    } catch {
      // No usable accelerator at all: the app still runs, on the CPU.
      const value: GpuInfo = {
        checked: true,
        available: false,
        acceleration: 'cpu',
        error: 'لم يتم العثور على بطاقة رسومات يمكن لمحرّك llama.cpp استخدامها.'
      }
      this.gpuCache = { at: Date.now(), value }
      return value
    }
  }

  /** First device the bundled llama.cpp reports, NVIDIA preferred. */
  private async llamaDevice(): Promise<GpuInfo | null> {
    const server = llamaServerPath()
    if (!server) return null
    try {
      const result = await new ProcessRunner().run(server, ['--list-devices'], {
        handlers: {},
        // A driver-level hang here used to block init() forever (the app sat on
        // "loading the studio"). Fail fast and fall back to CPU.
        timeoutMs: 20_000
      })
      if (result.code !== 0) return null
      const devices = parseDeviceList(result.stdoutTail)
      if (devices.length === 0) return null
      const preferred = devices.find((d) => /nvidia|geforce|rtx/i.test(d.name)) ?? devices[0]
      return {
        checked: true,
        available: true,
        name: preferred.name,
        vramMb: preferred.vramMb,
        driver: 'Vulkan',
        acceleration: 'vulkan'
      }
    } catch {
      return null
    }
  }

  private async diskFreeGb(): Promise<number | undefined> {
    if (this.cachedDisk && Date.now() - this.cachedDisk.at < 10_000) return this.cachedDisk.value
    try {
      const stats = await fsp.statfs(getPaths().root)
      const free = (Number(stats.bavail) * Number(stats.bsize)) / 1e9
      this.cachedDisk = { at: Date.now(), value: free }
      return free
    } catch {
      return undefined
    }
  }

  private ready(): EngineMarker | null {
    return readMarker()
  }

  async status(): Promise<SetupStatus> {
    const paths = getPaths()
    if (MOCK) {
      const gpu = await this.gpu()
      return {
        completed: true,
        running: this.running,
        phase: 'done',
        gpu,
        disk: { freeGb: 180, requiredGb: RUNTIME_GB + 2 },
        runtime: {
          uv: true,
          python: true,
          venv: true,
          deps: true,
          pythonVersion: '3.12 (mock)',
          cuda: true
        },
        models: {
          jais: {
            present: true,
            bytes: JAIS_VARIANTS.gguf.bytes,
            totalBytes: JAIS_VARIANTS.gguf.bytes,
            variant: 'gguf' as JaisVariantId,
            variantLabel: JAIS_VARIANTS.gguf.label
          },
          diarizer: { present: true, bytes: 110_000_000 }
        },
        paths: {
          dataRoot: paths.root,
          runtime: paths.runtime,
          models: paths.models,
          jobs: paths.jobs,
          logs: paths.logs
        }
      }
    }
    const ready = this.ready()
    const gpu = await this.gpu()
    const disk = await this.diskFreeGb()
    // enginePython() validates a borrowed interpreter still exists and falls
    // back to the managed venv, so the status cannot point at a dead path.
    const pythonPath = enginePython()
    const suggestedVariant = selectJaisVariant(gpu.vramMb)
    const borrowedDir = engineJaisDir()
    // A downloaded artifact takes over from a borrowed folder that holds a
    // different quantization: the app-owned copy is the one the device wants.
    const managedDir = join(paths.models, 'jais-asr')
    const managedOk = jaisComplete(managedDir) && jaisVariant(managedDir) === suggestedVariant
    const jaisDir = managedOk ? managedDir : borrowedDir
    const venv = existsSync(pythonPath)
    const uv = existsSync(paths.uv)
    const probe = (ready?.probe ?? {}) as Record<string, unknown>
    const deps = Boolean(ready?.completed) && venv
    const jaisBytes = dirSize(jaisDir)
    const customDiarizer = diarizerModel()
    const diarizerFile = customDiarizer && existsSync(customDiarizer) ? customDiarizer : ''
    const diarizerBytes = diarizerFile ? statSync(diarizerFile).size : nemoBytes()
    const installedVariant = jaisVariant(jaisDir)
    const activeVariant = installedVariant ?? suggestedVariant
    const jaisSpec = JAIS_VARIANTS[activeVariant]
    const modelReady = jaisComplete(jaisDir) && installedVariant === suggestedVariant
    const models = {
      jais: {
        present: jaisComplete(jaisDir),
        bytes: jaisBytes,
        totalBytes: jaisSpec.bytes,
        path: jaisDir,
        custom: Boolean(ready?.jaisDir) && jaisDir === borrowedDir,
        variant: activeVariant,
        variantLabel: jaisSpec.label,
        suggested: suggestedVariant,
        vramGb: jaisSpec.vramGb,
        wer: jaisSpec.wer
      },
      diarizer: {
        present: diarizerBytes > 50_000_000,
        bytes: diarizerBytes,
        path: diarizerFile || nemoCacheDirs().find((dir) => existsSync(dir)),
        custom: Boolean(diarizerFile)
      }
    }
    return {
      completed: deps && models.jais.present && models.diarizer.present,
      running: this.running,
      phase: ready?.completed ? 'done' : undefined,
      mode: ready?.mode ?? (ready ? 'managed' : undefined),
      engine: pythonPath,
      gpu,
      disk: {
        freeGb: disk,
        requiredGb: requiredDiskGb(suggestedVariant, !deps, !modelReady)
      },
      runtime: {
        uv,
        python: venv,
        venv,
        deps,
        pythonVersion: typeof probe.python === 'string' ? probe.python : undefined,
        cuda: gpu.acceleration === 'cuda'
      },
      models,
      paths: {
        dataRoot: paths.root,
        runtime: paths.runtime,
        models: paths.models,
        jobs: paths.jobs,
        logs: paths.logs
      }
    }
  }

  /**
   * Points the app at a Jais-ASR folder the user already has. When a suitable
   * Python + CUDA environment is also present, setup completes without a single
   * download; otherwise only the runtime is installed and the weights are kept.
   */
  async useExistingModel(input: string): Promise<SetupStatus> {
    if (this.running) throw new Error('التهيئة قيد التنفيذ، انتظر انتهاءها أولًا.')
    const dir = input.trim().replace(/^"|"$/g, '')
    if (!dir) throw new Error('أدخل مسار مجلد النموذج.')
    if (!existsSync(dir)) throw new Error(`المجلد غير موجود: ${dir}`)
    if (!jaisComplete(dir)) {
      throw new Error(
        'هذا المجلد لا يحتوي نسخة كاملة من Jais-ASR. يجب أن تجد فيه ملف GGUF للنموذج وملف mmproj بجانبه.'
      )
    }
    const gpu = await this.gpu(true)
    if (!gpu.available) {
      throw new Error('لم يتم العثور على معالج NVIDIA. يحتاج التفريغ إلى بطاقة NVIDIA بذاكرة 6 جيجابايت على الأقل.')
    }
    const python = await this.findExistingPython()
    const ready = Boolean(python)
    writeMarker({
      completed: ready,
      updatedAt: new Date().toISOString(),
      mode: ready ? 'existing' : 'managed',
      python: ready ? python!.executable : undefined,
      jaisDir: dir,
      probe: ready
        ? {
            python: python!.version,
            cuda: gpu.acceleration === 'cuda',
            device: gpu.name,
            source: 'system'
          }
        : undefined
    })
    if (ready) {
      this.progress('done', 100, 'المحرك الموجود على الجهاز جاهز')
    } else {
      this.progress('check', 0, 'النموذج مقبول — يلزم تثبيت المحرك فقط')
    }
    return this.status()
  }

  private async findExistingPython(): Promise<{
    executable: string
    version: string
  } | null> {
    const paths = getPaths()
    const candidates: Array<{ command: string; prefix: string[] }> = []
    const add = (command: string, prefix: string[] = []): void => {
      if (!candidates.some((item) => item.command === command && item.prefix.join(' ') === prefix.join(' '))) {
        candidates.push({ command, prefix })
      }
    }
    if (process.env.TAFREEGH_PYTHON) add(process.env.TAFREEGH_PYTHON)
    if (process.platform === 'win32') {
      add(paths.python)
      add('py', ['-3.12'])
      add('python')
      add('python3')
    } else {
      add(paths.python)
      add('python3.12')
      add('python3')
    }

    const probe = [
      'import json,sys,importlib.util',
      'o={"version":sys.version.split()[0],"executable":sys.executable}',
      'mods=["soundfile","numpy","scipy","noisereduce","huggingface_hub","imageio_ffmpeg"]',
      'o["missing"]=[m for m in mods if importlib.util.find_spec(m) is None]',
      'print("TAFREEGH_PROBE:"+json.dumps(o))'
    ].join('\n')

    for (const candidate of candidates) {
      if (candidate.command.includes('\\') && !existsSync(candidate.command)) continue
      try {
        const result = await new ProcessRunner().run(candidate.command, [...candidate.prefix, '-c', probe], {
          handlers: {}
        })
        if (result.code !== 0) continue
        const line = result.stdoutTail
          .split('\n')
          .reverse()
          .find((item) => item.includes('TAFREEGH_PROBE:'))
        if (!line) continue
        const info = JSON.parse(line.slice(line.indexOf('TAFREEGH_PROBE:') + 15)) as {
          executable?: string
          version?: string
          missing?: string[]
        }
        if (!info.executable || !info.version) continue
        // Torch is gone, but the worker still needs these packages; a bare
        // interpreter is better handled by creating the managed venv.
        if (info.missing && info.missing.length > 0) continue
        const [major, minor] = info.version.split('.').map((part) => Number.parseInt(part, 10))
        if (!(major > 3 || (major === 3 && minor >= 10))) continue
        return {
          executable: info.executable,
          version: info.version
        }
      } catch {
        // candidate not installed: try the next one
      }
    }
    return null
  }

  private uvEnv(): NodeJS.ProcessEnv {
    const paths = getPaths()
    return {
      UV_PYTHON_INSTALL_DIR: paths.uvPython,
      UV_CACHE_DIR: join(paths.runtime, 'uv-cache'),
      UV_HTTP_TIMEOUT: '300',
      UV_CONCURRENT_DOWNLOADS: '8',
      UV_INDEX_STRATEGY: 'unsafe-best-match',
      PYTHONUTF8: '1'
    }
  }

  private async ensureUv(): Promise<void> {
    const paths = getPaths()
    if (existsSync(paths.uv)) {
      try {
        // A truncated `uv.exe` (interrupted copy, antivirus) would fail every
        // install forever because the file exists.
        if (statSync(paths.uv).size > 1_000_000) return
      } catch {
        // fall through and re-download
      }
      rmSync(paths.uv, { force: true })
    }
    this.progress('uv', 0, 'تنزيل أداة تجهيز المحرك', false)
    const zip = join(paths.runtime, 'uv.zip')
    await downloadFile(
      UV_URL,
      zip,
      ({ received, total }) => {
        const pct = total ? Math.min(99, (received / total) * 100) : 0
        this.progress('uv', pct, 'تنزيل أداة تجهيز المحرك', !total, {
          bytesDone: received,
          bytesTotal: total || undefined
        })
      },
      this.abort.signal
    )
    try {
      const expected = (await downloadText(UV_URL + '.sha256', this.abort.signal)).split(/\s+/)[0]
      const actual = await sha256(zip)
      if (expected && expected.length === 64 && expected.toLowerCase() !== actual) {
        rmSync(zip, { force: true })
        throw new Error('فشل التحقق من سلامة أداة uv')
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('سلامة')) throw error
    }
    const dest = join(paths.runtime, 'uv')
    rmSync(dest, { recursive: true, force: true })
    await extract(zip, { dir: dest })
    rmSync(zip, { force: true })
    if (!existsSync(paths.uv)) {
      const found = walkFor(dest, process.platform === 'win32' ? 'uv.exe' : 'uv')
      if (!found) throw new Error('لم يتم العثور على ملف uv بعد فك الضغط')
      await fsp.copyFile(found, paths.uv)
    }
    this.progress('uv', 100, 'أداة التجهيز جاهزة')
  }

  private async runUv(args: string[], phase: SetupPhase, message: string): Promise<void> {
    const paths = getPaths()
    this.progress(phase, null, message, true)
    const result = await this.runner.run(paths.uv, args, {
      env: this.uvEnv(),
      handlers: {
        onStderr: (line) => {
          const clean = stripAnsi(line)
          if (clean.trim()) this.logLine(clean)
        },
        onStdout: (line) => {
          const clean = stripAnsi(line)
          if (clean.trim()) this.logLine(clean)
        }
      }
    })
    if (this.cancelled) throw new CancelledError()
    if (result.code !== 0) {
      const detail = result.stderrTail
        .split('\n')
        .map((line) => stripAnsi(line).trim())
        .filter(Boolean)
        .slice(-4)
        .join(' · ')
        .slice(0, 400)
      throw new Error(detail ? `${message} — ${detail}` : `${message} فشل`)
    }
  }

  /**
   * The Hub's own downloader is the right tool, but only the 0.3x line keeps a
   * partial file across restarts; 1.x has an open bug (huggingface_hub#4196)
   * where a killed run is discarded and the whole 3.7 GB starts over. Check the
   * interpreter the app actually runs — borrowed or managed — and pin it.
   */
  private async ensureResumableDownloads(): Promise<void> {
    if (MOCK || this.resumeReady) return
    const python = enginePython()
    if (await this.downloadsResume(python)) {
      this.resumeReady = true
      return
    }

    this.logLine('huggingface_hub 1.x restarts interrupted downloads; installing the 0.36 line')
    this.progress('jais', 0, 'تثبيت مكتبة تنزيل قابلة للاستئناف…', true)
    try {
      const result = await this.runner.run(
        python,
        ['-m', 'pip', 'install', '--disable-pip-version-check', 'huggingface-hub<1.0'],
        {
          env: this.uvEnv(),
          timeoutMs: 10 * 60_000,
          handlers: {
            onStderr: (line) => {
              const clean = stripAnsi(line)
              if (clean.trim()) this.logLine(clean)
            },
            onStdout: (line) => {
              const clean = stripAnsi(line)
              if (clean.trim()) this.logLine(clean)
            }
          }
        }
      )
      if (this.cancelled) throw new CancelledError()
      if (result.code !== 0 || !(await this.downloadsResume(python))) {
        const detail = result.stderrTail
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .pop()
        throw new Error(detail ?? 'pip exited without installing the pin')
      }
      this.logLine('interrupted downloads will now resume')
    } catch (error) {
      if (error instanceof CancelledError) throw error
      // Resume is a resilience feature, not a prerequisite: a machine without
      // pip or without network access must still be able to download the model.
      const detail = error instanceof Error ? error.message : String(error)
      this.logLine(`resume pin skipped: ${detail}`)
      this.logLine('a download interrupted here will restart from zero')
    } finally {
      this.resumeReady = true
    }
  }

  /** True when huggingface_hub in `python` is the 0.x line (resumable). */
  private async downloadsResume(python: string): Promise<boolean> {
    try {
      const result = await new ProcessRunner().run(
        python,
        ['-c', 'import huggingface_hub as h; print(h.__version__)'],
        { timeoutMs: 60_000 }
      )
      if (result.code !== 0) return false
      const version = result.stdoutTail.trim().split('\n').pop()?.trim() ?? ''
      const major = Number.parseInt(version.split('.')[0] ?? '', 10)
      return Number.isFinite(major) && major < 1
    } catch {
      return false
    }
  }

  /** Creates the managed venv when needed; true when it was (re)built. */
  private async ensurePython(): Promise<boolean> {
    const paths = getPaths()
    this.progress('python', null, 'تنزيل Python 3.12', true)
    await this.runUv(['python', 'install', '3.12'], 'python', 'تثبيت Python 3.12')
    this.progress('python', 70, 'إنشاء بيئة معزولة')
    const venvArgs = ['venv', paths.venv, '--python', '3.12']
    if (existsSync(paths.venv) && !existsSync(paths.python)) {
      rmSync(paths.venv, { recursive: true, force: true })
    }
    let created = false
    if (!existsSync(paths.venv)) {
      await this.runUv(venvArgs, 'python', 'إنشاء بيئة معزولة')
      created = true
    }
    if (!existsSync(paths.python)) throw new Error('لم يتم إنشاء بيئة Python')
    this.progress('python', 100, 'بيئة Python جاهزة')
    return created
  }

  private async installDeps(force = false): Promise<void> {
    const paths = getPaths()
    const ready = this.ready()
    // The marker only proves dependencies for the *managed* venv. A borrowed
    // ("existing") setup has no managed deps, and a recreated venv is empty
    // even though the marker still says completed.
    const installed =
      Boolean(ready?.completed) && ready?.mode !== 'existing' && existsSync(paths.python)
    if (!force && installed) {
      this.progress('deps', 100, 'مكتبات المحرك مثبتة')
      return
    }
    const requirements = join(paths.backend, 'requirements.txt')
    const py = paths.python

    this.progress('deps', 10, 'تثبيت مكتبات التفريغ والصوت', true)
    await this.runUv(
      ['pip', 'install', '--python', py, '-r', requirements],
      'deps',
      'تثبيت مكتبات التفريغ'
    )
    this.progress('deps', 92, 'التحقق من المعالج الرسومي', true)
  }

  private async probeAndPersist(): Promise<Record<string, unknown>> {
    this.progress('probe', null, 'التحقق من CUDA والمكتبات', true)
    let probe: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        probe = (await runWorker({
          runner: this.runner,
          args: ['probe', '--models-dir', getPaths().models],
          onEvent: () => undefined,
          onLog: (line) => this.logLine(line),
          env: this.hfEnv(),
          isCancelled: () => this.cancelled
        })) as Record<string, unknown>
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A managed venv whose packages were wiped still has python.exe and a
        // "completed" marker, so installDeps skipped it. Repair once, instead
        // of failing every retry with the same missing module.
        if (attempt === 0 && /مكتبات المحرك ناقصة/.test(message)) {
          if (enginePython() !== getPaths().python) {
            throw new Error(
              'بيئة Python المختارة لا تحتوي مكتبات التفريغ. أنشئ محركًا جديدًا من الإعداد أو ثبّت المكتبات في تلك البيئة.'
            )
          }
          this.progress('deps', 30, 'إعادة تثبيت مكتبات المحرك الناقصة', true)
          await this.installDeps(true)
          continue
        }
        throw error
      }
      // The probe only throws when a worker dependency is missing (repaired
      // above). CUDA is reported by the GPU driver and llama.cpp, not by a
      // Python package any more, so there is nothing to reinstall here.
      break
    }
    const previous = this.ready()
    // Probe used enginePython(); when that is not the managed venv the setup
    // is still borrowing an interpreter. Writing `managed` here used to drop
    // the borrowed path and sent every later job to an empty venv.
    const managedPython = getPaths().python
    const usingManaged = enginePython() === managedPython
    writeMarker({
      completed: true,
      updatedAt: new Date().toISOString(),
      mode: usingManaged ? 'managed' : 'existing',
      python: usingManaged ? undefined : enginePython(),
      jaisDir: previous?.jaisDir || undefined,
      probe
    })
    this.progress('probe', 100, 'المعالج الرسومي جاهز', false, {
      detail: typeof probe.device === 'string' ? probe.device : undefined
    })
    return probe
  }

  private async downloadModels(): Promise<void> {
    const paths = getPaths()
    await this.ensureResumableDownloads()
    const gpu = await this.gpu()
    const variant = selectJaisVariant(gpu.vramMb)
    const spec = JAIS_VARIANTS[variant]
    this.progress('jais', 0, `تنزيل نموذج التفريغ ${spec.label}`, false, {
      bytesDone: 0,
      bytesTotal: spec.bytes
    })
    await runWorker({
      runner: this.runner,
      args: ['setup-models', '--models-dir', paths.models, '--variant', variant],
      onEvent: (event) => {
        if (event.type === 'setup') {
          const phase = event.phase as SetupPhase
          this.emit({
            phase,
            pct: Number(event.pct ?? 0),
            indeterminate: Boolean(event.indeterminate),
            message: String(event.message ?? ''),
            detail: typeof event.detail === 'string' ? event.detail : undefined,
            bytesDone: typeof event.bytesDone === 'number' ? event.bytesDone : undefined,
            bytesTotal: typeof event.bytesTotal === 'number' ? event.bytesTotal : undefined
          })
        } else if (event.type === 'log') {
          this.logLine(String(event.message ?? ''))
        }
      },
      onLog: (line) => this.logLine(line),
      env: this.hfEnv(),
      isCancelled: () => this.cancelled
    })
    this.progress('done', 100, 'اكتمل تجهيز النماذج')
  }

  /** Download (or re-download) one model into the app's own models folder. */
  async downloadModel(kind: ModelKind): Promise<SetupStatus> {
    if (this.running) throw new Error('التهيئة قيد التنفيذ، انتظر انتهاءها أولًا.')
    const python = enginePython()
    if (!existsSync(python)) {
      throw new Error('ثبّت محرك التفريغ أولًا، ثم نزّل النماذج.')
    }
    // Downloading means "use the app's copy", so detach any borrowed path —
    // but keep it aside: a failed download must not throw away a working
    // setup the user already had.
    const restore = this.detachOverride(kind)

    this.running = true
    this.cancelled = false
    this.abort = new AbortController()
    try {
      // The Jais weights come from the Hub; make sure this interpreter keeps
      // a partial download alive before spending an hour on 3.7 GB.
      if (kind === 'jais') await this.ensureResumableDownloads()
      const args =
        kind === 'jais'
          ? [
              'setup-jais',
              '--models-dir',
              getPaths().models,
              '--variant',
              selectJaisVariant((await this.gpu()).vramMb)
            ]
          : ['setup-diarizer']
      await runWorker({
        runner: this.runner,
        args,
        onEvent: (event) => this.forwardSetupEvent(event, kind),
        onLog: (line) => this.logLine(line),
        timeoutMs: 4 * 3_600_000,
        env: this.hfEnv(),
        isCancelled: () => this.cancelled
      })
      // status() probes the Python fallback only when no setup is in flight.
      this.running = false
      const status = await this.status()
      const ok = status.models[kind].present
      if (!ok) {
        throw new Error(
          kind === 'jais'
            ? 'تعذّر تنزيل نموذج التفريغ. تحقّق من الاتصال والمساحة.'
            : 'تعذّر تنزيل نموذج تمييز المتحدثين. تحقّق من الاتصال.'
        )
      }
      return status
    } catch (error) {
      // Keep whatever the Hub already staged: huggingface_hub 0.36 resumes the
      // same `.incomplete` file, so stopping here costs nothing but disk space
      // and starting again continues from the same byte. Un-resumable 1.x
      // fragments are cleaned by the worker when the next download begins.
      restore()
      throw error
    } finally {
      this.running = false
    }
  }

  /**
   * Temporarily forget a borrowed model path so the worker writes into the
   * app-owned folder. Returns a function that puts the old choice back when
   * the download fails.
   */
  private detachOverride(kind: ModelKind): () => void {
    if (kind === 'jais') {
      const snapshot = readMarkerRaw()
      setJaisDir(undefined)
      return () => {
        if (snapshot) writeMarker(snapshot)
        else rmSync(getPaths().setup, { force: true })
      }
    }
    const snapshot = readOverrides()
    clearOverride('diarizer')
    return () => {
      writeOverrides({ diarizerModel: snapshot.diarizerModel })
    }
  }

  private forwardSetupEvent(event: Record<string, unknown>, fallback: SetupPhase): void {
    if (event.type !== 'setup') return
    this.emit({
      phase: (event.phase as SetupPhase) || fallback,
      pct: Number(event.pct ?? 0),
      indeterminate: Boolean(event.indeterminate),
      message: String(event.message ?? ''),
      detail: typeof event.detail === 'string' ? event.detail : undefined,
      bytesDone: typeof event.bytesDone === 'number' ? event.bytesDone : undefined,
      bytesTotal: typeof event.bytesTotal === 'number' ? event.bytesTotal : undefined
    })
  }

  /**
   * Point one model at a folder on this PC instead of downloading it.
   * Accepts the model's own folder or a parent that contains it.
   */
  async setModelPath(kind: ModelKind, input: string): Promise<SetupStatus> {
    if (this.running) throw new Error('التهيئة قيد التنفيذ، انتظر انتهاءها أولًا.')
    const dir = input.trim().replace(/^"|"$/g, '')
    if (!dir) throw new Error('اختر مجلدًا.')
    if (!existsSync(dir)) throw new Error(`المجلد غير موجود: ${dir}`)

    if (kind === 'jais') {
      if (!jaisComplete(dir)) {
        throw new Error(
          'هذا المجلد لا يحتوي نسخة كاملة من Jais-ASR. المقبول: زوج GGUF (ملف النموذج + ملف mmproj).'
        )
      }
      setJaisDir(dir)
      this.progress('done', 100, 'نموذج التفريغ من المسار المحدد')
      return this.status()
    }

    const gguf = findGguf(dir)
    if (!gguf) {
      throw new Error('لم أجد ملف .gguf لنموذج تمييز المتحدثين داخل هذا المجلد.')
    }
    if (statSync(gguf).size < 50_000_000) {
      throw new Error('ملف النموذج صغير جدًا. اختر ملف Nemotron-3-Diarization.q8_0.gguf الكامل.')
    }
    writeOverrides({ diarizerModel: gguf })
    this.progress('done', 100, 'نموذج تمييز المتحدثين من المسار المحدد')
    return this.status()
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.cancelled = false
    this.abort = new AbortController()
    try {
      this.progress('check', 0, 'فحص المعالج الرسومي والمساحة')
      if (MOCK) {
        this.progress('done', 100, 'الوضع التجريبي جاهز')
        this.running = false
        return
      }
      const gpu = await this.gpu(true)
      const variant = selectJaisVariant(gpu.vramMb)
      const ready = this.ready()
      const borrowedPython = Boolean(
        ready?.mode === 'existing' && ready.python && existsSync(ready.python)
      )
      const depsReady =
        borrowedPython || Boolean(ready?.completed && existsSync(getPaths().python))
      // The backend skips the download when the folder already holds the
      // recommended artifact (borrowed or managed), so only then is the model
      // size really needed on disk.
      const installedDir = engineJaisDir()
      const modelReady = jaisComplete(installedDir) && jaisVariant(installedDir) === variant
      const requiredGb = requiredDiskGb(variant, !depsReady, !modelReady)
      const disk = await this.diskFreeGb()
      if (disk !== undefined && disk < requiredGb) {
        throw new Error(
          `المساحة الحرة غير كافية: ${disk.toFixed(1)} جيجابايت. مطلوب ${requiredGb} جيجابايت على الأقل.`
        )
      }
      this.progress('check', 100, 'الفحص سليم')
      if (!borrowedPython) {
        await this.ensureUv()
        const freshVenv = await this.ensurePython()
        await this.installDeps(freshVenv)
      }
      await this.probeAndPersist()
      await this.downloadModels()
      this.progress('done', 100, 'التطبيق جاهز للاستخدام')
    } catch (error) {
      if (this.cancelled) {
        this.progress('check', 0, 'أُلغيت التهيئة')
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.progress('check', 0, 'فشلت التهيئة', false, { detail: message })
      throw error
    } finally {
      this.running = false
    }
  }

  cancel(): void {
    this.cancelled = true
    this.abort.abort()
    this.runner.cancel()
  }

  /**
   * 0.9.7 dropped the neural denoiser. Installs created by an older beta still
   * carry the Resemble checkpoint (~720 MB) and, when the app borrowed a Python
   * environment, torch + torchaudio + resemble-enhance (~5 GB). Run this once
   * so the update actually reclaims that space instead of leaving it on disk.
   */
  async cleanupLegacyTorch(): Promise<void> {
    if (MOCK) return
    const paths = getPaths()
    const marker = join(paths.runtime, 'torch-free.json')
    if (existsSync(marker)) return

    const failures: string[] = []
    // Windows keeps handles for a moment after a download (Defender scans the
    // 772 MB checkpoint, the indexer reads it), so a single rm can fail with
    // EBUSY/EPERM. Retry instead of losing the whole reclaim to one lock.
    const remove = (target: string, label: string): void => {
      try {
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
      } catch (error) {
        failures.push(`${label} (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
      }
    }

    // Every step is best-effort: a locked file in one place must not stop the
    // ~5 GB of site-packages cleanup below from running.
    remove(join(paths.models, LEGACY_DENOISER_DIR), 'models/resemble-enhance')
    remove(join(homedir(), '.cache', 'huggingface', 'hub', 'models--ResembleAI--resemble-enhance'), 'hf cache')
    remove(join(tmpdir(), 'tafreegh-deps'), 'temp deps')
    const denoiserGone = !existsSync(join(paths.models, LEGACY_DENOISER_DIR))

    const python = enginePython()
    let packagesGone = true
    if (existsSync(python)) {
      try {
        if (existsSync(paths.uv)) {
          await this.runner.run(
            paths.uv,
            ['pip', 'uninstall', '--python', python, 'torch', 'torchaudio', 'resemble-enhance', 'deepspeed'],
            { env: this.uvEnv(), handlers: {} }
          )
        } else {
          await this.runner.run(
            python,
            ['-m', 'pip', 'uninstall', '--yes', 'torch', 'torchaudio', 'resemble-enhance', 'deepspeed'],
            { handlers: {} }
          )
        }
      } catch (error) {
        failures.push(`pip uninstall (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
      }
      // pip/uv only delete files listed in the package metadata. Resemble wrote
      // its 713 MB checkpoint *inside* site-packages, outside that record, so
      // the folder survives the uninstall and must be removed explicitly.
      const purelib = await this.sitePackages(python)
      if (purelib) {
        for (const name of ['resemble_enhance', 'deepspeed']) {
          remove(join(purelib, name), name)
        }
        try {
          for (const entry of readdirSync(purelib)) {
            if (/^(resemble_enhance|deepspeed).*\.dist-info$/i.test(entry)) {
              remove(join(purelib, entry), entry)
            }
          }
        } catch {
          // unreadable site-packages: the package folders are gone already
        }
        packagesGone =
          !existsSync(join(purelib, 'resemble_enhance')) && !existsSync(join(purelib, 'deepspeed'))
      } else {
        failures.push('site-packages lookup')
        packagesGone = false
      }
    }

    this.logCleanup(failures)
    // Leave the marker unwritten when an app-owned folder survived, so the
    // next launch retries. External caches are reported but never block it.
    if (!denoiserGone || !packagesGone) return
    mkdirSync(paths.runtime, { recursive: true })
    writeFileSync(marker, JSON.stringify({ at: new Date().toISOString() }), 'utf8')
  }

  /** Diagnostic trail for the one-shot torch cleanup; silent on success. */
  private logCleanup(failures: string[]): void {
    if (failures.length === 0) return
    try {
      const dir = getPaths().logs
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'cleanup.log'), `${new Date().toISOString()} ${failures.join('; ')}\n`, 'utf8')
    } catch {
      // logging must never break startup
    }
  }

  private async sitePackages(python: string): Promise<string | null> {
    try {
      const result = await this.runner.run(
        python,
        ['-c', "import sysconfig;print(sysconfig.get_paths()['purelib'])"],
        { handlers: {} }
      )
      const dir = result.stdoutTail.trim().split('\n').pop()?.trim()
      return dir && existsSync(dir) ? dir : null
    } catch {
      return null
    }
  }

  async removeModels(): Promise<void> {
    const paths = getPaths()
    const marker = this.ready()
    // The app-owned copies and path overrides go in every mode.
    rmSync(join(paths.root, 'models.json'), { force: true })
    this.removeDenoiserCache()
    // `jaisDir` may point at the app's own folder even when the runtime was
    // borrowed, and a leftover app-owned copy must not survive a reset.
    rmSync(paths.jais, { recursive: true, force: true })
    if (marker?.mode !== 'existing') {
      // The NeMo cache under LOCALAPPDATA is shared with other installs; in a
      // borrowed setup it may belong to the user's own environment.
      for (const dir of nemoCacheDirs()) rmSync(dir, { recursive: true, force: true })
    }
    // The model weights and the Python environment of a borrowed setup belong
    // to the user, so only the marker is dropped there.
    rmSync(paths.setup, { force: true })
  }

  private removeDenoiserCache(): void {
    rmSync(join(getPaths().models, LEGACY_DENOISER_DIR), { recursive: true, force: true })
  }
}

/** Largest .gguf under the chosen folder (nemo-speech takes a file path). */
function findGguf(root: string, depth = 4): string | null {
  let best: { file: string; size: number } | null = null
  const queue: Array<{ dir: string; level: number }> = [{ dir: root, level: 0 }]
  while (queue.length) {
    const { dir, level } = queue.shift()!
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (level < depth) queue.push({ dir: full, level: level + 1 })
      } else if (entry.name.toLowerCase().endsWith('.gguf')) {
        try {
          const size = statSync(full).size
          if (!best || size > best.size) best = { file: full, size }
        } catch {
          // file vanished mid-walk
        }
      }
    }
  }
  return best?.file ?? null
}

function walkFor(dir: string, name: string): string | null {  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return full
    if (entry.isDirectory()) {
      const found = walkFor(full, name)
      if (found) return found
    }
  }
  return null
}
