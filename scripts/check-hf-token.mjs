// Verifies the HF-token IPC path and that a real model download reports live bytes.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = await mkdtemp(join(tmpdir(), 'tafreegh-hfcheck-'))
await mkdir(join(dataDir, 'models'), { recursive: true })

// Borrow the real marker so the engine resolves to the system Python.
const real = join(process.env.LOCALAPPDATA, 'Tafreegh', 'setup.json')
if (existsSync(real)) await copyFile(real, join(dataDir, 'setup.json'))

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    TAFREEGH_DATA_DIR: dataDir,
    TAFREEGH_SINGLE_INSTANCE: '0',
    TAFREEGH_MOCK: ''
  }
})

const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.waitForSelector('.setup', { timeout: 60_000 })

const result = { token: {}, download: {}, errors }

// 1) A malformed token must be rejected by the Hub check, and nothing stored.
result.token = await page.evaluate(async () => {
  const before = (await window.tafreegh.settings.get()).hfTokenSet
  let message = null
  try {
    await window.tafreegh.settings.setHfToken('hf_' + 'a'.repeat(30))
  } catch (error) {
    message = String(error.message ?? error)
  }
  const after = (await window.tafreegh.settings.get()).hfTokenSet
  return { before, after, rejected: Boolean(message), message }
})

// 2) Real Jais download: watch the byte counter the worker reports.
await page.evaluate(() => {
  window.__samples = []
  window.tafreegh.setup.onProgress((p) => {
    if (p.phase === 'jais') {
      window.__samples.push({
        at: Date.now(),
        pct: Math.round(p.pct),
        bytes: typeof p.bytesDone === 'number' ? p.bytesDone : null,
        total: typeof p.bytesTotal === 'number' ? p.bytesTotal : null
      })
    }
  })
  window.__pending = window.tafreegh.setup.downloadModel('jais').then(
    (status) => ({ ok: true, status }),
    (error) => ({ ok: false, message: String(error?.message ?? error) })
  )
})

await page.waitForTimeout(35_000)
const samples = await page.evaluate(() => window.__samples)
await page.evaluate(() => window.tafreegh.setup.cancel())
const settled = await page.evaluate(() => window.__pending)
await page.waitForTimeout(3_000)

const first = samples[0] ?? null
const last = samples.at(-1) ?? null
result.download = {
  events: samples.length,
  first,
  last,
  grew: Boolean(first && last && last.bytes > first.bytes),
  monotonic: samples.every((s, i) => i === 0 || s.bytes >= samples[i - 1].bytes),
  settled,
  // Pinned huggingface_hub 0.36 keeps the partial: the next run resumes it.
  stagingKept: existsSync(join(dataDir, 'models', 'jais-asr', '.cache', 'huggingface', 'download'))
}

console.log(JSON.stringify(result, null, 2))
await app.close()
