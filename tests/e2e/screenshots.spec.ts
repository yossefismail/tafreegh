import { test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * README/demo captures.
 *
 * Everything is mock mode with a throwaway data dir, so no real recording is
 * ever opened and no personal audio or transcript can end up in the repository.
 * Skipped unless TAFREEGH_SHOTS=1.
 */
const ROOT = process.cwd()
const OUT = join(ROOT, 'docs', 'screenshots')

function installedStatus(dataRoot: string): Record<string, unknown> {
  return {
    completed: true,
    running: false,
    phase: 'done',
    mode: 'managed',
    engine: 'C:\\Users\\demo\\AppData\\Local\\Tafreegh\\runtime\\venv\\Scripts\\python.exe',
    gpu: {
      checked: true,
      available: true,
      name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      vramMb: 8188,
      driver: '580.65',
      acceleration: 'vulkan'
    },
    disk: { freeGb: 96.4, requiredGb: 8 },
    runtime: {
      uv: true,
      python: true,
      venv: true,
      deps: true,
      pythonVersion: '3.12.10',
      cuda: false
    },
    models: {
      jais: {
        present: true,
        bytes: 3_711_000_000,
        totalBytes: 3_711_000_000,
        path: 'C:\\Users\\demo\\AppData\\Local\\Tafreegh\\models\\jais-asr',
        custom: false,
        variant: 'gguf',
        variantLabel: 'Jais-ASR Q4_K_M (GGUF)',
        suggested: 'gguf',
        vramGb: 8,
        wer: 22.99
      },
      diarizer: {
        present: true,
        bytes: 112_000_000,
        path: 'C:\\Users\\demo\\AppData\\Local\\Tafreegh\\models\\nemo-diarization',
        custom: false
      }
    },
    paths: {
      dataRoot,
      runtime: join(dataRoot, 'runtime'),
      models: join(dataRoot, 'models'),
      jobs: join(dataRoot, 'jobs'),
      logs: join(dataRoot, 'logs')
    }
  }
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; audio: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'tafreegh-shots-'))
  // A neutral, plausible location: the screenshots show the source path, and a
  // temp folder full of random characters reads as a bug.
  const demoDir = join(process.env.PUBLIC ?? tmpdir(), 'Music')
  await mkdir(demoDir, { recursive: true })
  const audio = join(demoDir, 'اجتماع فريق المنتج.m4a')
  await writeFile(audio, Buffer.alloc(8192, 4))

  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: {
      ...process.env,
      TAFREEGH_MOCK: '1',
      TAFREEGH_DATA_DIR: dataDir,
      TAFREEGH_SINGLE_INSTANCE: '0'
    }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  return { app, page, audio }
}

async function stub(app: ElectronApplication, channel: string, value: unknown): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, payload) => {
      ipcMain.removeHandler(payload.channel)
      ipcMain.handle(payload.channel, () => payload.value)
    },
    { channel, value }
  )
}

/** Toasts are transient status noise in a still image. */
async function clearToasts(page: Page): Promise<void> {
  await page
    .locator('.toast')
    .first()
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => undefined)
}

test.describe('screenshots', () => {
  test.skip(process.env.TAFREEGH_SHOTS !== '1', 'set TAFREEGH_SHOTS=1 to refresh the README images')

  test('capture setup, processing and result', async () => {
    test.setTimeout(300_000)
    await mkdir(OUT, { recursive: true })
    const { app, page, audio } = await launch()

    // ---- setup wizard, as a fresh install sees it
    await page.waitForSelector('.home__headline', { timeout: 60_000 })
    await stub(app, 'setup:status', { ...installedStatus('C:\\Users\\demo'), completed: false, phase: 'check' })
    await page.reload()
    await page.waitForSelector('.setup', { timeout: 30_000 })
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(OUT, '01-setup.png') })

    // ---- home, ready to start
    await stub(app, 'setup:status', installedStatus('C:\\Users\\demo'))
    await page.reload()
    await page.waitForSelector('.home__headline', { timeout: 30_000 })
    await stub(app, 'app:pick-audio', audio)
    await page.locator('.dropzone').click()
    await page.setViewportSize({ width: 1440, height: 1040 })
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(OUT, '02-home.png') })
    await page.setViewportSize({ width: 1440, height: 900 })

    // ---- processing
    await page.locator('.transcribe-options__go').click()
    await page.waitForSelector('.workorder', { timeout: 20_000 })
    await page.waitForTimeout(2600)
    // Let the "started" toast dismiss on its own: removing toast nodes behind
    // React's back would break the tree on the next render.
    await page
      .locator('.toast')
      .first()
      .waitFor({ state: 'detached', timeout: 10_000 })
      .catch(() => undefined)
    await page.screenshot({ path: join(OUT, '03-processing.png') })

    // ---- result: summary first, then the transcript with the speaker strip
    await page.waitForSelector('.result', { timeout: 120_000 })
    const frame = page.frameLocator('.result__frame iframe')
    await frame.locator('.chunk').first().waitFor({ timeout: 60_000 })
    await clearToasts(page)
    await page.waitForTimeout(900)
    // Scroll past the cover so the summary and the pinned player are in frame.
    await frame.locator('.playerbar').scrollIntoViewIfNeeded()
    await frame.locator('body').evaluate(() => window.scrollBy(0, 420))
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(OUT, '04-result.png') })

    // The strip is the star of this release: one clean crop of it in place.
    await frame.locator('.chunk').nth(3).click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(OUT, '05-speakers.png') })

    await app.close()
  })
})
