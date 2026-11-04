import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('mock studio flow: home, progress, result, settings', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tafreegh-e2e-'))
  const mediaDir = join(dataDir, 'media')
  await mkdir(mediaDir, { recursive: true })
  const audioPath = join(mediaDir, 'اجتماع فريق المنتج.m4a')
  await writeFile(audioPath, Buffer.alloc(4096, 7))

  const resultDir = join(process.cwd(), 'test-results')
  await mkdir(resultDir, { recursive: true })

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      TAFREEGH_MOCK: '1',
      TAFREEGH_DATA_DIR: dataDir,
      TAFREEGH_SINGLE_INSTANCE: '0'
    }
  })

  const page = await app.firstWindow()
  await page.waitForSelector('.home__headline', { timeout: 30_000 })
  await expect(page.locator('.home__headline')).toContainText('الصوت')
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(resultDir, '01-home.png') })

  const job = (await page.evaluate(
    async ({ file }) => {
      return window.tafreegh.jobs.start({ filePath: file, language: 'EG', enhance: true })
    },
    { file: audioPath }
  )) as { id: string }

  await expect(page.locator('.history-item').first()).toBeVisible({ timeout: 15_000 })
  await page.locator('.history-item').first().click()
  await page.waitForSelector('.workorder', { timeout: 15_000 })
  await page.waitForTimeout(1600)
  await page.screenshot({ path: join(resultDir, '02-progress.png') })

  await page.waitForSelector('.result', { timeout: 90_000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(resultDir, '03-result.png') })

  const htmlPath = join(dataDir, 'jobs', job.id, 'transcript.html')
  expect(existsSync(htmlPath)).toBeTruthy()
  const html = await readFile(htmlPath, 'utf8')
  expect(html.indexOf('id="recording-summary"')).toBeGreaterThan(-1)
  expect(html.indexOf('id="recording-summary"')).toBeLessThan(html.indexOf('<main>'))
  expect(html).toContain('id="ui-theme"')
  expect(html).toContain('id="ui-player-js"')
  expect(html).toContain('titleblock')

  await page.locator('.sidebar__settings').click()
  await page.waitForSelector('.settings__title', { timeout: 15_000 })
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(resultDir, '04-settings.png') })

  await app.close()
})
