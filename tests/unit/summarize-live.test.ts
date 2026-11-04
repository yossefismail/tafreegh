import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JobTranscript } from '../../src/shared/types'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { summarizeTranscript } from '../../src/main/services/summarize'

// Manual harness: re-runs only the summary stage of a finished job against the
// local Ollama daemon. Skipped unless TAFREEGH_LIVE_JOB points at a job folder.
const jobDir = process.env.TAFREEGH_LIVE_JOB
const outDir = process.env.TAFREEGH_LIVE_OUT

async function ollama(body: Record<string, unknown>): Promise<Response> {
  return fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: false, keep_alive: '15m', ...body })
  })
}

const providers = {
  async complete(req: {
    system: string
    user: string
    model: string
    maxTokens: number
    temperature: number
    onStatus?: (message: string) => void
  }): Promise<string> {
    req.onStatus?.('summarizing')
    if (outDir) {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(
        join(outDir, `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`),
        JSON.stringify({ system: req.system, user: req.user, maxTokens: req.maxTokens }, null, 2),
        'utf8'
      )
    }
    const res = await ollama({
      model: req.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user }
      ],
      think: false,
      // Mirrors ollama.ts: the native API only honours num_ctx, and the app
      // ships with 8192 so the model does not silently truncate the prompt.
      options: { temperature: req.temperature, num_ctx: 8192, num_predict: req.maxTokens }
    })
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { message?: { content?: string } }
    return json.message?.content ?? ''
  },
  async release(req: { model: string }): Promise<void> {
    await ollama({ model: req.model, messages: [], keep_alive: 0 }).catch(() => undefined)
  }
}

const settings = {
  language: 'ar',
  dialect: 'EG',
  enhance: true,
  summarizer: {
    provider: 'ollama',
    model: process.env.TAFREEGH_LIVE_MODEL ?? 'gemma4:e4b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    temperature: 0.2,
    maxTokens: 2500
  },
  providers: {}
}

describe.skipIf(!jobDir || !outDir)('summarize live', () => {
  it('re-runs the summary stage and writes summary.md + moments.json', async () => {
    const transcript = JSON.parse(readFileSync(join(jobDir!, 'transcript.json'), 'utf8')) as JobTranscript
    const started = Date.now()
    const result = await summarizeTranscript(providers as never, settings as never, transcript)
    mkdirSync(outDir!, { recursive: true })
    writeFileSync(join(outDir!, 'summary.md'), result.markdown, 'utf8')
    writeFileSync(
      join(outDir!, 'moments.json'),
      JSON.stringify(result.moments, null, 2),
      'utf8'
    )
    console.log(`chunks=${result.chunks} elapsed=${Math.round((Date.now() - started) / 1000)}s`)
    console.log(JSON.stringify(result.moments, null, 2))
    expect(result.markdown.length).toBeGreaterThan(0)
  }, 1_800_000)
})
