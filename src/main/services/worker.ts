import { existsSync } from 'node:fs'
import type { ProcessRunner } from './process'
import { engineJaisDir, enginePython, llamaServerPath, readMarker } from './engine'
import { diarizerModel } from './models'
import { getPaths, MOCK } from './paths'
import { describeWorkerFailure } from './workerErrors'

export class CancelledError extends Error {
  constructor() {
    super('أُلغي التنفيذ')
    this.name = 'CancelledError'
  }
}

export interface WorkerRunOptions {
  runner: ProcessRunner
  args: string[]
  onEvent: (event: Record<string, unknown>) => void
  onLog?: (line: string) => void
  timeoutMs?: number
  /** Extra environment (e.g. an HF token) merged over the defaults. */
  env?: NodeJS.ProcessEnv
  /**
   * True when the caller asked for the process to stop. Lets the worker report
   * a cancellation instead of a generic "exit code 1" failure after the tree
   * was killed.
   */
  isCancelled?: () => boolean
}

/** A single JSONL event is a few KB; anything bigger is a runaway print. */
const MAX_EVENT_LINE = 1_000_000

function pythonCommand(): { command: string; prefix: string[] } {
  if (MOCK) {
    if (process.platform === 'win32') return { command: 'py', prefix: ['-3.12'] }
    return { command: 'python3.12', prefix: [] }
  }
  const python = enginePython()
  if (!existsSync(python)) {
    throw new Error('لم يتم تجهيز محرك التفريغ بعد. افتح الإعداد وأكمل التهيئة.')
  }
  return { command: python, prefix: [] }
}

export async function runWorker(options: WorkerRunOptions): Promise<unknown> {
  const paths = getPaths()
  if (!existsSync(paths.worker)) {
    throw new Error('ملفات محرك التفريغ غير موجودة. أعد تثبيت التطبيق ثم حاول مجددًا.')
  }
  const diarizer = diarizerModel()
  const llamaServer = llamaServerPath()
  const { command, prefix } = pythonCommand()
  const borrowed = Boolean(readMarker()?.jaisDir)
  let result: unknown = undefined
  let workerError: string | undefined
  let cancelled = false
  let settled = false
  let timedOut = false

  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true
        options.runner.cancel()
      }, options.timeoutMs)
    : null

  try {
    const run = await options.runner.run(
      command,
      [...prefix, paths.worker, ...options.args],
      {
        cwd: paths.backend,
        env: {
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          // Keep the installed tree read-only: no __pycache__ next to the
          // backend sources (those .pyc files survived uninstall).
          PYTHONDONTWRITEBYTECODE: '1',
          HF_HUB_DISABLE_XET: '1',
          // The model rows show real byte progress from the worker, so the
          // library's own "Fetching N files: 0%" bar (which only ticks when a
          // whole file lands) is pure noise in the technical log.
          HF_HUB_DISABLE_PROGRESS_BARS: '1',
          // A silent socket must fail and retry instead of hanging forever.
          HF_HUB_DOWNLOAD_TIMEOUT: '30',
          HF_HUB_ETAG_TIMEOUT: '30',
          TOKENIZERS_PARALLELISM: 'false',
          NEMO_DIAR_DEVICE: 'cpu',
          JAIS_LOCAL_DIR: engineJaisDir(),
          ...(llamaServer ? { TAFREEGH_LLAMA_SERVER: llamaServer } : {}),
          ...(diarizer ? { NEMO_DIAR_MODEL: diarizer } : {}),
          TAFREEGH_DATA_DIR: paths.root,
          ...(borrowed ? { HF_HUB_OFFLINE: '1' } : {}),
          ...(MOCK ? { TAFREEGH_MOCK: '1' } : {}),
          ...options.env
        },
        handlers: {
          onStdout: (line) => {
            const trimmed = line.trim()
            if (!trimmed) return
            // never hand a multi-megabyte "line" to JSON.parse or the renderer
            if (trimmed.length > MAX_EVENT_LINE) {
              options.onLog?.(`${trimmed.slice(0, 2_000)}…`)
              return
            }
            let parsed: unknown
            try {
              parsed = JSON.parse(trimmed)
            } catch {
              // library prints are redirected to stderr by worker.py, but a
              // crash before the fd swap can still write plain text here
              options.onLog?.(trimmed)
              return
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              options.onLog?.(trimmed)
              return
            }
            const event = parsed as Record<string, unknown>
            options.onEvent(event)
            if (event.type === 'done') {
              result = event.result
              settled = true
            } else if (event.type === 'error') {
              workerError = String(event.message ?? 'worker failed').slice(0, 2_000)
            } else if (event.type === 'cancelled') {
              cancelled = true
            }
          },
          onStderr: (line) => {
            const trimmed = line.trim()
            if (trimmed) options.onLog?.(trimmed.length > 8_000 ? `${trimmed.slice(0, 8_000)}…` : trimmed)
          }
        }
      }
    )
    // A user cancel wins over anything the dying process wrote: the exit code
    // of a killed interpreter is meaningless.
    if (cancelled || options.isCancelled?.() === true) throw new CancelledError()
    if (workerError) throw new Error(workerError)
    if (!settled || result === undefined) {
      throw new Error(
        describeWorkerFailure({ code: run.code, stderrTail: run.stderrTail, timedOut })
      )
    }
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}
