import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = await mkdtemp(join(tmpdir(), 'tafreegh-ollama-'))
await mkdir(join(dataDir, 'models'), { recursive: true })
await writeFile(
  join(dataDir, 'setup.json'),
  JSON.stringify({
    completed: true,
    mode: 'existing',
    python: 'C:\\Users\\demo\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
    probe: { python: '3.12.10', torch: '2.11.0+cu128', cuda: true, source: 'system' }
  })
)

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, TAFREEGH_DATA_DIR: dataDir, TAFREEGH_SINGLE_INSTANCE: '0', TAFREEGH_MOCK: '' }
})
const page = await app.firstWindow()
await page.waitForSelector('.setup', { timeout: 60_000 })

const out = await page.evaluate(async () => {
  const started = Date.now()
  try {
    const models = await window.tafreegh.providers.models({ provider: 'ollama' })
    return { ok: true, ms: Date.now() - started, models }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: String(error) }
  }
})
console.log(JSON.stringify(out, null, 2))
await app.close()
