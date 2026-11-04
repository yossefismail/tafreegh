import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => tmpdir()
  }
}))

import type { ProcessRunner, RunResult } from '../../src/main/services/process'
import { CancelledError, runWorker } from '../../src/main/services/worker'

const root = mkdtempSync(join(tmpdir(), 'tafreegh-worker-'))

beforeAll(() => {
  process.env.TAFREEGH_DATA_DIR = root
  process.env.TAFREEGH_SINGLE_INSTANCE = '0'
  // getPaths() is computed from the env on first use.
  const python = join(
    root,
    'runtime',
    'venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python'
  )
  mkdirSync(dirname(python), { recursive: true })
  writeFileSync(python, '')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.TAFREEGH_DATA_DIR
})

interface FakeRun {
  lines?: string[]
  stderr?: string
  code?: number
  onRun?: () => void
}

function fakeRunner(script: FakeRun): ProcessRunner {
  return {
    cancel: () => undefined,
    run: (
      _command: string,
      _args: string[],
      options: { handlers?: { onStdout?: (line: string) => void } }
    ): Promise<RunResult> => {
      script.onRun?.()
      for (const line of script.lines ?? []) options.handlers?.onStdout?.(line)
      return Promise.resolve({
        code: script.code ?? 0,
        stdoutTail: (script.lines ?? []).join('\n'),
        stderrTail: script.stderr ?? ''
      })
    }
  } as unknown as ProcessRunner
}

describe('runWorker', () => {
  it('returns the result carried by the done event', async () => {
    const result = await runWorker({
      runner: fakeRunner({ lines: [JSON.stringify({ type: 'done', result: { present: true } })] }),
      args: ['probe'],
      onEvent: () => undefined
    })
    expect(result).toEqual({ present: true })
  })

  it('routes non-JSON stdout to the log instead of failing', async () => {
    const logs: string[] = []
    await runWorker({
      runner: fakeRunner({
        lines: ['loading model…', JSON.stringify({ type: 'done', result: 7 })]
      }),
      args: ['probe'],
      onEvent: () => undefined,
      onLog: (line) => logs.push(line)
    })
    expect(logs).toEqual(['loading model…'])
  })

  it('surfaces a clean message for a stale argparse choice', async () => {
    const failure = runWorker({
      runner: fakeRunner({
        code: 2,
        stderr: [
          'usage: tafreegh-worker [-h] ...',
          "tafreegh-worker: error: argument --variant: invalid choice: 'gguf'"
        ].join('\n')
      }),
      args: ['setup-jais'],
      onEvent: () => undefined
    })
    const error = await failure.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('--variant')
    expect(message).not.toContain('usage:')
  })

  it('treats a killed process as a cancellation, not an exit-code failure', async () => {
    let cancelled = false
    const failure = runWorker({
      runner: fakeRunner({ code: 1, onRun: () => (cancelled = true) }),
      args: ['run'],
      onEvent: () => undefined,
      isCancelled: () => cancelled
    })
    await expect(failure).rejects.toBeInstanceOf(CancelledError)
  })

  it('reports a timeout when the process is killed by the deadline', async () => {
    let finish: ((result: RunResult) => void) | null = null
    const runner = {
      cancel: () => finish?.({ code: 1, stdoutTail: '', stderrTail: '' }),
      run: () =>
        new Promise<RunResult>((resolveRun) => {
          finish = resolveRun
        })
    } as unknown as ProcessRunner
    const failure = runWorker({
      runner,
      args: ['setup-jais'],
      onEvent: () => undefined,
      timeoutMs: 15
    })
    await expect(failure).rejects.toThrow(/المدة المسموح/)
  })

  it('honours the cancelled event emitted by the worker', async () => {
    const failure = runWorker({
      runner: fakeRunner({ lines: [JSON.stringify({ type: 'cancelled' })] }),
      args: ['run'],
      onEvent: () => undefined
    })
    await expect(failure).rejects.toBeInstanceOf(CancelledError)
  })
})
