// Verify a cancelled model download leaves no staging garbage behind.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = await mkdtemp(join(tmpdir(), 'tafreegh-cancel-'))
await mkdir(join(dataDir, 'models'), { recursive: true })
await writeFile(
  join(dataDir, 'setup.json'),
  JSON.stringify(
    {
      completed: true,
      updatedAt: new Date().toISOString(),
      mode: 'existing',
      python: 'C:\\Users\\demo\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
      probe: { python: '3.12.10', torch: '2.11.0+cu128', cuda: true, source: 'system' }
    },
    null,
    2
  )
)

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, TAFREEGH_DATA_DIR: dataDir, TAFREEGH_SINGLE_INSTANCE: '0', TAFREEGH_MOCK: '' }
})
const page = await app.firstWindow()
try {
  await page.waitForSelector('.setup', { timeout: 60_000 })
} catch (error) {
  await page.screenshot({ path: join(dataDir, 'fail.png') })
  const text = await page.evaluate(() => document.body.innerText.slice(0, 800))
  const dir = await page.evaluate(() => document.body.innerHTML.slice(0, 400))
  console.log(JSON.stringify({ error: String(error), text, dir, dataDir }, null, 2))
  await app.close()
  process.exit(1)
}

const started = Date.now()
// Fire the download through the same IPC the Settings button uses.
await page.evaluate(() => {
  window.__err = null
  window.tafreegh.setup.downloadModel('jais').catch((e) => {
    window.__err = String(e && e.message ? e.message : e)
  })
})
await page.waitForTimeout(30_000)

const during = await page.evaluate(async () => {
  const s = await window.tafreegh.setup.status()
  return { present: s.models.jais.present, running: s.running, bytes: s.models.jais.bytes }
})
await page.evaluate(() => window.tafreegh.setup.cancel())
await page.waitForTimeout(8_000)

const target = join(dataDir, 'models', 'jais-asr')
const staging = join(target, '.cache', 'huggingface', 'download')
const after = await page.evaluate(async () => {
  const s = await window.tafreegh.setup.status()
  return { present: s.models.jais.present, running: s.running, err: window.__err }
})

console.log(
  JSON.stringify(
    {
      dataDir,
      seconds: Math.round((Date.now() - started) / 1000),
      during,
      after,
      stagingExists: existsSync(staging),
      stagingFiles: existsSync(staging) ? (await readdir(staging)).length : 0,
      files: existsSync(target) ? await readdir(target) : []
    },
    null,
    2
  )
)
await app.close()
