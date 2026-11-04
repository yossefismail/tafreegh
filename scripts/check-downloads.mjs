// One-off download-button check against the dev build on an isolated data dir.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, copyFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = await mkdtemp(join(tmpdir(), 'tafreegh-dl-'))
await mkdir(join(dataDir, 'models'), { recursive: true })

// Reuse the real marker so the engine resolves to the system Python.
const real = join(process.env.LOCALAPPDATA, 'Tafreegh', 'setup.json')
let seeded = false
if (existsSync(real)) {
  await copyFile(real, join(dataDir, 'setup.json'))
  seeded = true
}

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
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

const result = { dataDir, seeded, denoiser: null, diarizer: null, jais: null, errors }

async function boot() {
  await page.waitForSelector('.home__headline', { timeout: 60_000 })
  await page.locator('.sidebar__settings').click()
  await page.waitForSelector('.settings__title', { timeout: 20_000 })
}

// Collect progress events the renderer receives.
await page.evaluate(() => {
  window.__dl = { events: 0, lastBytes: 0, kinds: new Set() }
  window.tafreegh.setup.onProgress((p) => {
    window.__dl.events += 1
    if (typeof p.bytesDone === 'number') window.__dl.lastBytes = p.bytesDone
    if (p.phase) window.__dl.kinds.add(p.phase)
  })
})

await boot()

async function cardButton(index) {
  const card = page.locator('.model-card').nth(index)
  const btn = card.locator('.model-row__actions .btn').first()
  await btn.waitFor({ state: 'visible', timeout: 15_000 })
  return btn
}

async function snapshot() {
  return page.evaluate(async () => {
    const s = await window.tafreegh.setup.status()
    return {
      jais: s.models.jais.present,
      diarizer: s.models.diarizer.present,
      denoiser: s.models.denoiser.present,
      bytes: window.__dl?.lastBytes ?? 0,
      events: window.__dl?.events ?? 0
    }
  })
}

// 1) denoiser: must start streaming real bytes, then cancel.
try {
  await (await cardButton(2)).click()
  await page.waitForTimeout(25_000)
  const before = await snapshot()
  result.denoiser = { events: before.events, bytes: before.bytes }
  await page.evaluate(() => window.tafreegh.setup.cancel())
  await page.waitForTimeout(3_000)
  result.denoiser.cancelled = true
} catch (error) {
  result.denoiser = { error: String(error) }
}

// 2) diarizer: let it finish (small artifact).
try {
  const btn = await cardButton(1)
  await btn.click()
  const deadline = Date.now() + 8 * 60_000
  let done = false
  while (Date.now() < deadline) {
    const s = await snapshot()
    if (s.diarizer) {
      done = true
      break
    }
    await page.waitForTimeout(5_000)
  }
  result.diarizer = { done, state: await snapshot() }
} catch (error) {
  result.diarizer = { error: String(error) }
}

// 3) jais: click the recommended-download button, prove bytes flow, then cancel.
try {
  const btn = await cardButton(0)
  await btn.click()
  await page.waitForTimeout(60_000)
  const mid = await snapshot()
  await page.evaluate(() => window.tafreegh.setup.cancel())
  await page.waitForTimeout(4_000)
  const after = await snapshot()
  const modelsDir = join(dataDir, 'models', 'jais-asr')
  result.jais = {
    bytesAfter60s: mid.bytes,
    events: mid.events,
    cancelledPresent: after.jais,
    files: existsSync(modelsDir) ? await readdir(modelsDir) : []
  }
} catch (error) {
  result.jais = { error: String(error) }
}

console.log(JSON.stringify(result, null, 2))
await app.close()
