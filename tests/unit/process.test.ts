import { describe, expect, it } from 'vitest'
import { ProcessRunner } from '../../src/main/services/process'

describe('ProcessRunner', () => {
  it('streams stdout and reports the exit code', async () => {
    const runner = new ProcessRunner()
    const lines: string[] = []
    const result = await runner.run(
      process.execPath,
      ['-e', 'console.log("one");console.log("two")'],
      { handlers: { onStdout: (line) => lines.push(line) } }
    )
    expect(result.code).toBe(0)
    expect(lines).toEqual(['one', 'two'])
    expect(result.stdoutTail).toContain('two')
  })

  it('cancels a long-running process and settles instead of hanging', async () => {
    const runner = new ProcessRunner()
    const running = runner.run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
    await new Promise((resolve) => setTimeout(resolve, 250))
    runner.cancel()
    const result = await running
    expect(result.code === 0).toBe(false)
  }, 20_000)

  it('rejects when the timeout expires instead of blocking the caller', async () => {
    const runner = new ProcessRunner()
    const started = Date.now()
    await expect(
      runner.run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 400 })
    ).rejects.toThrow(/did not finish within 400 ms/)
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 20_000)

  it('rejects with the spawn error when the command does not exist', async () => {
    const runner = new ProcessRunner()
    await expect(
      runner.run('tafreegh-command-that-does-not-exist-12345', [])
    ).rejects.toThrow()
  })
})
