// Real download check: the pin is applied, progress stays inside the total,
// and an interrupted download continues from the same byte after a restart.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, copyFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = await mkdtemp(join(tmpdir(), 'tafreegh-resume-'))
await mkdir(join(dataDir, 'models'), { recursive: true })
const real = join(process.env.LOCALAPPDATA, 'Tafreegh', 'setup.json')
if (existsSync(real)) await copyFile(real, join(dataDir, 'setup.json'))

const stagingDir = join(dataDir, 'models', 'jais-asr', '.cache', 'huggingface', 'download')

async function staged() {
  if (!existsSync(stagingDir)) return []
  const names = (await readdir(stagingDir)).filter((name) => name.endsWith('.incomplete'))
  const out = []
  for (const name of names) {
    out.push({ name, bytes: (await stat(join(stagingDir, name))).size })
  }
  return out
}

async function run(label, seconds) {
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
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.waitForSelector('.setup', { timeout: 60_000 })

  await page.evaluate(() => {
    window.__samples = []
    window.__start = Date.now()
    window.tafreegh.setup.onProgress((progress) => {
      if (progress.phase === 'jais') {
        window.__samples.push({
          at: Date.now() - window.__start,
          pct: Math.round(progress.pct),
          bytes: progress.bytesDone ?? null,
          total: progress.bytesTotal ?? null
        })
      }
    })
    window.__pending = window.tafreegh.setup.downloadModel('jais').then(
      (status) => ({ ok: true, status }),
      (error) => ({ ok: false, message: String(error?.message ?? error) })
    )
  })

  await page.waitForTimeout(seconds * 1000)
  const samples = await page.evaluate(() => window.__samples)
  await page.evaluate(() => window.tafreegh.setup.cancel())
  await page.evaluate(() => window.__pending)
  await page.waitForTimeout(3_000)
  await app.close()

  const first = samples[0] ?? null
  const last = samples.at(-1) ?? null
  return {
    label,
    events: samples.length,
    first,
    last,
    earlyMax: samples.filter((s) => s.at <= 10_000).reduce((max, s) => Math.max(max, s.bytes ?? 0), 0),
    monotonic: samples.every((s, i) => i === 0 || s.bytes >= samples[i - 1].bytes),
    overshoot: samples.some((s) => s.total && s.bytes > s.total),
    errors
  }
}

const before = await staged()
const first = await run('first', 40)
const between = await staged()
const second = await run('second', 25)
const after = await staged()
const stagedBytes = between.reduce((sum, entry) => sum + entry.bytes, 0)

console.log(
  JSON.stringify(
    {
      first,
      second,
      staging: { before, between, after },
      stagedBytes,
      // A fresh run starts at 0; a resumed one is already past what was staged.
      resumed: stagedBytes > 0 && second.earlyMax >= stagedBytes * 0.9,
      sameFile: between.length > 0 && after.some((entry) => entry.name === between[0].name),
      uuidFree: after.every((entry) => entry.name.split('.').length <= 3),
      dataDir
    },
    null,
    2
  )
)
