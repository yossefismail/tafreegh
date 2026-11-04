import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface StreamHandlers {
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
}

export interface RunResult {
  code: number | null
  stdoutTail: string
  stderrTail: string
}

/** The tail is diagnostic context only; keep a runaway line from eating RAM. */
const MAX_TAIL_LINE = 4_000

function keepTail(buffer: string[], line: string): void {
  buffer.push(line.length > MAX_TAIL_LINE ? `${line.slice(0, MAX_TAIL_LINE)}…` : line)
  if (buffer.length > 400) buffer.shift()
}

export class ProcessRunner {
  private current: ChildProcessWithoutNullStreams | null = null

  get child(): ChildProcessWithoutNullStreams | null {
    return this.current
  }

  cancel(): void {
    const child = this.current
    if (!child || child.killed || child.exitCode !== null) return
    if (process.platform === 'win32' && child.pid) {
      try {
        // Killing the tree matters: python spawns llama-server and ffmpeg.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        // Without this listener a failed `taskkill` spawn surfaces as an
        // uncaught 'error' event and takes the whole app down.
        killer.on('error', () => {
          try {
            child.kill()
          } catch {
            // process already gone
          }
        })
        killer.unref()
      } catch {
        try {
          child.kill()
        } catch {
          // process already gone
        }
      }
    } else {
      try {
        child.kill('SIGTERM')
      } catch {
        // process already gone
      }
    }
  }

  run(
    command: string,
    args: string[],
    options: {
      cwd?: string
      env?: NodeJS.ProcessEnv
      handlers?: StreamHandlers
      /** Hard limit; the process tree is killed when it expires. */
      timeoutMs?: number
    } = {}
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        // `spawn` never goes through a shell, so spaces and quotes in the
        // command or arguments are passed to the OS verbatim.
        child = spawn(command, args, {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (error) {
        reject(error)
        return
      }
      this.current = child
      const stdout: string[] = []
      const stderr: string[] = []
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        fn()
      }

      const out = createInterface({ input: child.stdout })
      out.on('line', (line) => {
        keepTail(stdout, line)
        options.handlers?.onStdout?.(line)
      })
      const err = createInterface({ input: child.stderr })
      err.on('line', (line) => {
        keepTail(stderr, line)
        options.handlers?.onStderr?.(line)
      })

      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          // A hung probe must not hang the whole app: kill the tree and fail.
          this.cancel()
          settle(() =>
            reject(new Error(`${command} did not finish within ${options.timeoutMs} ms`))
          )
        }, options.timeoutMs)
      }

      child.on('error', (error) => {
        this.current = null
        out.close()
        err.close()
        settle(() => reject(error))
      })
      child.on('close', (code) => {
        this.current = null
        settle(() =>
          resolve({
            code,
            stdoutTail: stdout.slice(-60).join('\n'),
            stderrTail: stderr.slice(-60).join('\n')
          })
        )
      })
    })
  }
}
