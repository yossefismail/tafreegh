import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir() },
  dialog: { showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))

vi.mock('../../src/main/services/worker', () => ({
  CancelledError: class CancelledError extends Error {
    constructor() {
      super('أُلغي التنفيذ')
      this.name = 'CancelledError'
    }
  },
  runWorker: vi.fn()
}))

import { HistoryStore } from '../../src/main/services/history'
import { JobService, writeSpeakerNames } from '../../src/main/services/jobs'
import { SettingsStore } from '../../src/main/services/settings'
import { runWorker } from '../../src/main/services/worker'
import type { ProvidersService } from '../../src/main/services/providers'
import type { JobEvent, JobTranscript } from '../../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'tafreegh-jobs-'))
process.env.TAFREEGH_DATA_DIR = root

const workerMock = vi.mocked(runWorker)
const events: JobEvent[] = []

function transcript(): JobTranscript {
  return {
    duration: 12,
    speechStart: 0,
    speechEnd: 12,
    language: 'ar',
    model: 'jais',
    speakers: ['S1'],
    windows: 1,
    lines: [],
    turns: []
  }
}

beforeEach(() => {
  workerMock.mockReset()
  events.length = 0
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.TAFREEGH_DATA_DIR
})

describe('JobService.start', () => {
  it('runs the worker without a --quant flag and renders the fixed GGUF label', async () => {
    const input = join(root, 'recording.m4a')
    writeFileSync(input, Buffer.alloc(4096, 1))

    workerMock.mockImplementation(async (options) => {
      if (options.args[0] === 'run') {
        const dir = options.args[options.args.indexOf('--job-dir') + 1]
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'transcript.json'), JSON.stringify(transcript()), 'utf8')
      }
      return undefined
    })

    const settings = new SettingsStore()
    settings.update({ summarizer: { ...settings.get().summarizer, provider: 'none' } })
    const jobs = new JobService(
      new HistoryStore(),
      settings,
      {} as ProvidersService,
      (event) => events.push(event)
    )

    const job = await jobs.start({ filePath: input, language: 'EG', enhance: false })
    await vi.waitFor(() => {
      const latest = events
        .filter((event): event is Extract<JobEvent, { type: 'job' }> => event.type === 'job')
        .at(-1)
      expect(latest?.job.id).toBe(job.id)
      expect(latest?.job.status).toBe('done')
    })

    const runArgs = workerMock.mock.calls[0][0].args
    expect(runArgs[0]).toBe('run')
    expect(runArgs).not.toContain('--quant')
    expect(runArgs.join(' ')).not.toContain('4bit')
    expect(runArgs.join(' ')).not.toContain('8bit')

    const renderCall = workerMock.mock.calls.find(([options]) => options.args[0] === 'render')
    expect(renderCall).toBeDefined()
    const renderArgs = renderCall![0].args
    expect(renderArgs[renderArgs.indexOf('--model') + 1]).toBe(
      'Jais-ASR GGUF · Nemotron-3-Diarization'
    )
  })

  it('names the exact summary model in the render --model line', async () => {
    const input = join(root, 'summarized.m4a')
    writeFileSync(input, Buffer.alloc(4096, 1))

    workerMock.mockImplementation(async (options) => {
      if (options.args[0] === 'run') {
        const dir = options.args[options.args.indexOf('--job-dir') + 1]
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'transcript.json'), JSON.stringify(transcript()), 'utf8')
      }
      return undefined
    })

    const settings = new SettingsStore()
    settings.update({
      summarizer: { ...settings.get().summarizer, provider: 'ollama', model: 'gemma4:e4b' }
    })
    const providers = {
      complete: vi.fn(async () => '**نظرة عامة:** ملخص قصير للتسجيل.'),
      release: vi.fn(async () => undefined)
    } as unknown as ProvidersService
    const jobs = new JobService(new HistoryStore(), settings, providers, (event) =>
      events.push(event)
    )

    const job = await jobs.start({ filePath: input, language: 'EG', enhance: false })
    await vi.waitFor(() => {
      const latest = events
        .filter((event): event is Extract<JobEvent, { type: 'job' }> => event.type === 'job')
        .at(-1)
      expect(latest?.job.id).toBe(job.id)
      expect(latest?.job.status).toBe('done')
    })

    const renderCall = workerMock.mock.calls.find(([options]) => options.args[0] === 'render')
    const renderArgs = renderCall![0].args
    expect(renderArgs[renderArgs.indexOf('--model') + 1]).toBe(
      'Jais-ASR GGUF · Nemotron-3-Diarization · gemma4:e4b'
    )
  })
})

describe('writeSpeakerNames', () => {
  function page(dir: string, payload = '{}'): string {
    const file = join(dir, 'transcript.html')
    writeFileSync(
      file,
      `<html><body><script type="application/json" id="ui-speaker-names">${payload}</script></body></html>`,
      'utf8'
    )
    return file
  }

  it('rewrites the embedded names block in place', () => {
    const dir = mkdtempSync(join(root, 'names-'))
    const file = page(dir)

    expect(writeSpeakerNames(file, { A: 'د. سارة' })).toBe(true)
    const html = readFileSync(file, 'utf8')
    const block = html.split('id="ui-speaker-names">')[1].split('</script>')[0]
    expect(JSON.parse(block)).toEqual({ A: 'د. سارة' })
  })

  it('is a no-op when the page carries no names block', () => {
    const dir = mkdtempSync(join(root, 'names-'))
    const file = join(dir, 'plain.html')
    writeFileSync(file, '<html></html>', 'utf8')

    expect(writeSpeakerNames(file, { A: 'x' })).toBe(false)
    expect(writeSpeakerNames(join(dir, 'missing.html'), { A: 'x' })).toBe(false)
  })

  it('escapes markup so a name cannot break out of the JSON block', () => {
    const dir = mkdtempSync(join(root, 'names-'))
    const file = page(dir)

    writeSpeakerNames(file, { A: '</script><b>x' })
    const html = readFileSync(file, 'utf8')
    expect(html.split('</script>').length).toBe(2)
    expect(html).toContain('\\u003c')
  })
})
