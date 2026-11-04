import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Full UI journey for Tafreegh in mock mode.
 *
 * Everything runs offline against the dev build (`out/`), with a throwaway
 * TAFREEGH_DATA_DIR. Native dialogs and long-running setup steps are stubbed
 * from the main process with `app.evaluate`; the harness itself never edits
 * production code.
 */

const ROOT = process.cwd()
const SHOTS = join(ROOT, 'test-results')

/** Shape of a SetupStatus, good enough for the wizard + settings screens. */
function firstRunStatus(
  dataRoot: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    completed: false,
    running: false,
    phase: 'check',
    mode: 'managed',
    ...overrides,
    engine: 'C:\\data\\runtime\\venv\\Scripts\\python.exe',
    gpu: {
      checked: true,
      available: true,
      name: 'RTX 4060 (stub)',
      vramMb: 8192,
      driver: '580.00',
      acceleration: 'vulkan'
    },
    disk: { freeGb: 180, requiredGb: 12 },
    runtime: { uv: false, python: false, venv: false, deps: false },
    models: {
      jais: {
        present: true,
        bytes: 3_720_000_000,
        totalBytes: 3_720_000_000,
        path: 'C:\\models\\jais-asr',
        custom: false,
        variant: 'gguf',
        variantLabel: 'Jais-ASR Q4_K_M (GGUF)',
        suggested: 'gguf-q8',
        vramGb: 12,
        wer: 22.99
      },
      diarizer: {
        present: true,
        bytes: 110_000_000,
        path: 'C:\\models\\nemo',
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

interface Harness {
  app: ElectronApplication
  page: Page
  dataDir: string
  audioPath: string
  errors: string[]
}

const openApps: ElectronApplication[] = []

test.afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close().catch(() => undefined)
  }
})

async function launch(_test: string): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'tafreegh-e2e-'))
  await mkdir(join(dataDir, 'media'), { recursive: true })
  const audioPath = join(dataDir, 'media', 'اجتماع فريق المنتج.m4a')
  await writeFile(audioPath, Buffer.alloc(8192, 7))
  await mkdir(SHOTS, { recursive: true })

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
  openApps.push(app)

  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })

  return { app, page, dataDir, audioPath, errors }
}

async function waitForHome(page: Page): Promise<void> {
  await page.waitForSelector('.home__headline', { timeout: 60_000 })
}

async function stubStatus(app: ElectronApplication, status: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ ipcMain }, value) => {
    ipcMain.removeHandler('setup:status')
    ipcMain.handle('setup:status', () => value)
  }, status)
}

async function stubPickAudio(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ ipcMain }, value) => {
    ipcMain.removeHandler('app:pick-audio')
    ipcMain.handle('app:pick-audio', () => value)
  }, file)
}

async function pickAndStart(page: Page): Promise<void> {
  await page.locator('.dropzone').click()
  await expect(page.locator('.dropzone.has-file')).toBeVisible()
  const start = page.locator('.transcribe-options__go')
  await expect(start).toBeEnabled()
  await start.click()
  await page.waitForSelector('.workorder', { timeout: 20_000 })
}

async function jobIdOfNewest(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const jobs = await window.tafreegh.jobs.list()
    return jobs[0]?.id ?? ''
  })
}

function assertNoRuntimeErrors(errors: string[]): void {
  expect(errors, `unexpected renderer errors:\n${errors.join('\n')}`).toEqual([])
}

/* ------------------------------------------------------------------ boot */

test('boot screen animates, then the Arabic RTL shell loads cleanly', async () => {
  const { app, page, errors } = await launch('boot')

  // Keep the boot screen on screen long enough to inspect the animation.
  await waitForHome(page)
  await app.evaluate(({ ipcMain, app: electronApp }) => {
    ipcMain.removeHandler('app:info')
    ipcMain.handle('app:info', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1400))
      return {
        version: electronApp.getVersion(),
        platform: process.platform,
        mock: true,
        dataRoot: process.env.TAFREEGH_DATA_DIR
      }
    })
  })

  await page.reload()
  await page.waitForSelector('.boot', { timeout: 15_000 })
  await expect(page.locator('.boot__word')).toHaveText('تفريغ')
  await expect(page.locator('.boot__row')).toContainText('جارٍ تحميل الاستوديو')

  const spinner = page.locator('.boot .spinner')
  await expect(spinner).toBeVisible()
  const first = await spinner.evaluate((element) => ({
    transform: getComputedStyle(element).transform,
    animations: element.getAnimations().map((animation) => ({
      name: animation.animationName,
      state: animation.playState
    }))
  }))
  expect(first.animations).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'spin', state: 'running' })])
  )
  await page.screenshot({ path: join(SHOTS, 'boot-0.png') })
  await page.waitForTimeout(140)
  await page.screenshot({ path: join(SHOTS, 'boot-1.png') })
  const second = await spinner.evaluate((element) => getComputedStyle(element).transform)
  expect(second).not.toBe(first.transform)

  await waitForHome(page)
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('.home__headline')).toContainText('الصوت')
  await expect(page.locator('.home .dropzone')).toBeVisible()
  await expect(page.locator('.sidebar__empty')).toContainText('لا توجد تسجيلات بعد')
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl')
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('ar')

  const overflow = await page.evaluate(() => {
    const workspace = document.querySelector('.workspace') as HTMLElement
    return {
      doc: document.documentElement.scrollWidth,
      width: innerWidth,
      workspace: workspace.scrollWidth - workspace.clientWidth
    }
  })
  expect(overflow.doc).toBeLessThanOrEqual(overflow.width + 1)
  expect(overflow.workspace).toBeLessThanOrEqual(1)

  await page.screenshot({ path: join(SHOTS, 'boot-2-home.png') })
  assertNoRuntimeErrors(errors)
})

/* ------------------------------------------------------------------ setup */

test('first-run setup: wizard, language, failure card, retry and copy', async () => {
  const { app, page, dataDir, errors } = await launch('setup')
  await waitForHome(page)

  await stubStatus(app, firstRunStatus(dataDir))
  await page.reload()
  await page.waitForSelector('.setup', { timeout: 30_000 })

  // Step rail: first step is current before any download starts.
  const steps = page.locator('.setup-step')
  await expect(steps).toHaveCount(4)
  await expect(steps.first()).toHaveClass(/is-current/)
  await expect(page.locator('.setup__title')).toContainText('لنُجهّز استوديوك')
  await expect(page.locator('.setup-check__row')).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'ابدأ التجهيز' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'لدي النموذج مثبتًا مسبقًا' })
  ).toBeVisible()

  // Disk numbers must read left-to-right inside the Arabic page (bidi).
  const diskText = await page.locator('.setup-check__row').nth(1).innerText()
  expect(diskText).toContain('180.00 GB / 12 GB')

  // AR -> EN -> AR keeps the document direction in sync.
  const langButtons = page.locator('.setup__rail .lang-select button')
  await langButtons.nth(1).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe('ltr')
  await expect(page.locator('.setup__title')).toContainText('Let')
  await page.screenshot({ path: join(SHOTS, 'setup-english.png') })
  await langButtons.nth(0).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe('rtl')

  // "I already have the model": an invalid folder must surface the failure
  // card (persistent, with Retry + Copy), not just a transient toast.
  await app.evaluate(({ ipcMain }, dir) => {
    ipcMain.removeHandler('setup:pick-model-dir')
    ipcMain.handle('setup:pick-model-dir', () => dir)
  }, dataDir)
  await page.getByRole('button', { name: 'لدي النموذج مثبتًا مسبقًا' }).click()
  await page.waitForSelector('.setup-error', { timeout: 15_000 })
  await expect(page.locator('.setup-error')).toContainText('لا يحتوي نسخة كاملة')
  await expect(page.locator('.toast--error')).toBeVisible()

  const folderMessage = (await page.locator('.setup-error p').innerText()).trim()
  await page.getByRole('button', { name: 'نسخ' }).click()
  await expect(page.locator('.toast--success').filter({ hasText: 'تم النسخ' }).last()).toBeVisible()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(folderMessage)
  await page.screenshot({ path: join(SHOTS, 'setup-error-folder.png') })

  // A real download failure (the raw worker usage message) drives the same
  // card. Stub the IPC to stream progress and then fail.
  await app.evaluate(({ ipcMain, BrowserWindow }, config) => {
    ipcMain.removeHandler('setup:start')
    ipcMain.handle('setup:start', async () => {
      const window = BrowserWindow.getAllWindows()[0]
      const send = (payload: unknown): void => {
        if (window && !window.isDestroyed()) window.webContents.send('setup:event', payload)
      }
      const phases = ['check', 'uv', 'python', 'deps', 'probe', 'jais', 'diarizer']
      for (let index = 0; index < config.steps; index++) {
        const pct = Math.min(99, Math.round(((index + 1) / config.steps) * 100))
        send({
          phase: phases[Math.min(phases.length - 1, Math.floor(index / 2))],
          pct,
          indeterminate: index < 2,
          message: `stub setup step ${index}`,
          logLine: index % 2 === 0 ? `worker log line ${index}` : undefined
        })
        await new Promise((resolve) => setTimeout(resolve, config.interval))
      }
      throw new Error(config.error)
    })
  }, { steps: 12, interval: 150, error: "argument --variant: invalid choice: 'gguf'" })

  await page.getByRole('button', { name: 'إعادة المحاولة' }).click()

  // The progress panel was previously unreachable: `setup.running` only came
  // from the initial snapshot, so this selector never appeared.
  await page.waitForSelector('.setup-progress', { timeout: 10_000 })
  await expect(page.locator('.setup-progress__head .spinner')).toBeVisible()
  await expect(page.locator('.setup .progressbar')).toHaveClass(/is-indeterminate/)

  let previousPct = -1
  let sawStableFill = false
  for (let sample = 0; sample < 8; sample++) {
    const state = await page.evaluate(() => {
      const bar = document.querySelector('.setup .progressbar') as HTMLElement | null
      const fill = document.querySelector('.setup .progressbar__fill') as HTMLElement | null
      const barRect = bar?.getBoundingClientRect()
      const fillRect = fill?.getBoundingClientRect()
      const pct = document.querySelector('.setup .big-pct')?.textContent ?? ''
      return {
        pct: Number.parseInt(pct.replace(/[^\d]/g, ''), 10) || 0,
        bar: barRect ? { left: barRect.left, right: barRect.right } : null,
        fill: fillRect ? { left: fillRect.left, right: fillRect.right } : null,
        animations: bar
          ? bar.getAnimations({ subtree: true }).map((animation) => ({
              name: animation.animationName,
              state: animation.playState
            }))
          : [],
        steps: Array.from(document.querySelectorAll('.setup-step')).map(
          (element) => element.className
        ),
        log: document.querySelector('.setup-log')?.textContent ?? ''
      }
    })

    expect(state.pct).toBeGreaterThanOrEqual(previousPct)
    previousPct = state.pct
    if (state.bar && state.fill) {
      // Regression: the sweep used to travel from -40% to 104%, leaving the
      // bar visually empty at the end of every cycle.
      expect(state.fill.left).toBeGreaterThanOrEqual(state.bar.left - 1)
      expect(state.fill.right).toBeLessThanOrEqual(state.bar.right + 1)
      sawStableFill = true
    }
    expect(state.animations).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'hatch', state: 'running' })])
    )
    await page.waitForTimeout(140)
  }
  expect(sawStableFill).toBe(true)
  expect(previousPct).toBeGreaterThan(0)

  // Screenshot frames 120ms apart for the loading-animation review.
  for (let frame = 0; frame < 3; frame++) {
    await page.screenshot({ path: join(SHOTS, `setup-progress-${frame}.png`) })
    await page.waitForTimeout(120)
  }

  await page.waitForSelector('.setup-error', { timeout: 20_000 })
  const failure = (await page.locator('.setup-error p').innerText()).trim()
  expect(failure).toBe("argument --variant: invalid choice: 'gguf'")
  expect(failure).not.toContain('Error invoking remote method')
  await expect(page.locator('.toast--error').filter({ hasText: 'invalid choice' })).toBeVisible()

  await page.getByRole('button', { name: 'نسخ' }).click()
  await expect(page.locator('.toast--success').filter({ hasText: 'تم النسخ' }).last()).toBeVisible()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(failure)

  // Retry restarts the flow (progress visible again) and lands back on the
  // failure card when the run fails again.
  await page.getByRole('button', { name: 'إعادة المحاولة' }).click()
  await expect(page.locator('.setup-progress')).toBeVisible()
  await page.waitForSelector('.setup-error', { timeout: 20_000 })
  await expect(page.locator('.setup-progress')).toHaveCount(0)
  await page.screenshot({ path: join(SHOTS, 'setup-retry-failed.png') })

  // A successful run reaches step 04 and the "who writes the summary?" screen.
  await stubStatus(app, firstRunStatus(dataDir, { completed: true, phase: 'done' }))
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('setup:start')
    ipcMain.handle('setup:start', async () => undefined)
  })
  await page.getByRole('button', { name: 'إعادة المحاولة' }).click()
  await page.waitForSelector('.setup-ready', { timeout: 15_000 })
  await expect(page.locator('.setup-step').last()).toHaveClass(/is-current/)
  await expect(page.locator('.setup-summary')).toBeVisible()
  await expect(page.locator('.summary-model')).toHaveCount(4)
  const modelSize = page.locator('.summary-model__size').first()
  await expect(modelSize).toContainText('حجم التنزيل')
  expect(await modelSize.locator('bdi[dir="ltr"]').count()).toBe(1)
  await page.screenshot({ path: join(SHOTS, 'setup-finish.png') })

  assertNoRuntimeErrors(errors)
})

/* ------------------------------------------------------------------ home */

test('home: dropzone, drag overlay, picker wiring and empty state', async () => {
  const { app, page, dataDir, audioPath, errors } = await launch('home')
  await waitForHome(page)

  await expect(page.locator('.home__headline')).toBeVisible()
  await expect(page.locator('.how')).toBeVisible()
  await expect(page.locator('.home__recent')).toHaveCount(0)

  // Drag-enter anywhere shows the full-window overlay, drag-leave hides it.
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(2048)], 'clip.m4a', { type: 'audio/mp4' }))
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true }))
  })
  await expect(page.locator('.drop-overlay')).toBeVisible()
  await expect(page.locator('.drop-overlay__title')).toBeVisible()
  await expect(page.locator('.drop-overlay')).toHaveClass(/drop-overlay/)
  await page.waitForTimeout(320)
  await page.screenshot({ path: join(SHOTS, 'home-drag-overlay.png') })
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(2048)], 'clip.m4a', { type: 'audio/mp4' }))
    window.dispatchEvent(new DragEvent('dragleave', { dataTransfer: transfer, bubbles: true }))
  })
  await expect(page.locator('.drop-overlay')).toHaveCount(0)

  // The picker is stubbed at the IPC boundary; the dropzone stays a button.
  await stubPickAudio(app, audioPath)
  await expect(page.locator('.dropzone')).toHaveAttribute('role', 'button')

  // Keyboard activation opens the picker before a file is chosen.
  await page.evaluate(() => {
    ;(document.querySelector('.dropzone') as HTMLElement).focus()
  })
  await page.keyboard.press('Enter')
  await expect(page.locator('.dropzone.has-file')).toBeVisible()
  await expect(page.locator('.dropzone__file-name')).toHaveText('اجتماع فريق المنتج.m4a')
  await expect(page.locator('.dropzone__file-meta')).toContainText('M4A')
  await expect(page.locator('.transcribe-options__go')).toBeEnabled()
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(SHOTS, 'home-file-picked.png') })

  // Changing the file keeps the card and reopens the picker.
  await page.getByRole('button', { name: 'تغيير الملف' }).click()
  await expect(page.locator('.dropzone.has-file')).toBeVisible()

  // A non-audio pick is rejected with a toast and keeps the previous file.
  const pdfPath = join(dataDir, 'notes.pdf')
  await writeFile(pdfPath, Buffer.from('%PDF-1.4'))
  await stubPickAudio(app, pdfPath)
  await page.getByRole('button', { name: 'تغيير الملف' }).click()
  await expect(page.locator('.toast--error')).toContainText('هذه الصيغة غير مدعومة')
  await expect(page.locator('.dropzone__file-name')).toHaveText('اجتماع فريق المنتج.m4a')

  // Regression: the overlay is pointer-events:none, so a drop is delivered to the
  // element underneath. Dropping on the dropzone used to leave the overlay stuck
  // on screen because that element swallowed the event.
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(2048)], 'clip.m4a', { type: 'audio/mp4' }))
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true }))
  })
  await expect(page.locator('.drop-overlay')).toBeVisible()
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(2048)], 'clip.m4a', { type: 'audio/mp4' }))
    const dz = document.querySelector('.dropzone') as HTMLElement
    dz.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
    )
  })
  await expect(page.locator('.drop-overlay')).toHaveCount(0)

  assertNoRuntimeErrors(errors)
})

/* --------------------------------------------------------------- progress */

test('progress: monotonic percent, indeterminate bar, timer, log, cancel', async () => {
  const { app, page, audioPath, errors } = await launch('progress')
  await waitForHome(page)
  await stubPickAudio(app, audioPath)
  await pickAndStart(page)

  await expect(page.locator('.workorder')).toBeVisible()
  await expect(page.locator('.step')).toHaveCount(6)
  await expect(page.locator('.progressbar')).toBeVisible()

  const seen: number[] = []
  let sawIndeterminate = false
  let firstClock = ''
  let secondClock = ''
  let expandedLog = false
  let maxStepsDone = 0
  let jobFailure = ''
  const currentStepLabels = new Set<string>()
  const deadline = Date.now() + 60_000
  for (let sample = 0; Date.now() < deadline; sample++) {
    if (await page.locator('.result').count()) break
    if (await page.locator('.job-alert').count()) {
      jobFailure = (await page.locator('.job-alert p').innerText().catch(() => '')) || 'job failed'
      break
    }
    const state = await page.evaluate(() => {
      const bar = document.querySelector('.progressbar')
      const fill = document.querySelector('.progressbar__fill')
      const barRect = bar?.getBoundingClientRect()
      const fillRect = fill?.getBoundingClientRect()
      const pctText =
        document.querySelector('.big-pct')?.getAttribute('aria-label') ??
        document.querySelector('.big-pct')?.textContent ??
        ''
      return {
        pct: Number.parseInt(pctText.replace(/[^\d]/g, ''), 10) || 0,
        indeterminate: Boolean(bar?.classList.contains('is-indeterminate')),
        bar: barRect ? { left: barRect.left, right: barRect.right } : null,
        fill: fillRect ? { left: fillRect.left, right: fillRect.right } : null,
        animations: bar
          ? bar.getAnimations({ subtree: true }).map((animation) => ({
              name: animation.animationName,
              state: animation.playState
            }))
          : [],
        clock: document.querySelector('.progress-meta')?.textContent ?? ''
      }
    })
    seen.push(state.pct)
    const steps = await page.evaluate(() => ({
      done: document.querySelectorAll('.step.is-done').length,
      current: document.querySelector('.step.is-current .step__label')?.textContent ?? ''
    }))
    maxStepsDone = Math.max(maxStepsDone, steps.done)
    if (steps.current) currentStepLabels.add(steps.current)
    if (state.indeterminate) sawIndeterminate = true
    if (state.bar && state.fill && state.indeterminate) {
      expect(state.fill.left).toBeGreaterThanOrEqual(state.bar.left - 1)
      expect(state.fill.right).toBeLessThanOrEqual(state.bar.right + 1)
    }
    if (state.animations.length) {
      expect(state.animations).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'hatch', state: 'running' })])
      )
    }
    if (sample === 2) {
      await page.screenshot({ path: join(SHOTS, 'progress-running.png') })
      // Expand the technical log while the job is still running.
      await page.locator('.tech-log summary').click()
      await expect(page.locator('.tech-log')).toHaveAttribute('open', '')
      await expect(page.locator('.tech-log__body')).toBeVisible()
      expandedLog = true
      firstClock = state.clock
      await page.waitForTimeout(1200)
      secondClock = await page.locator('.progress-meta').innerText()
    }
    await page.waitForTimeout(160)
  }

  expect(seen.length).toBeGreaterThan(2)
  expect(jobFailure, `the mock job failed: ${jobFailure}`).toBe('')
  for (let index = 1; index < seen.length; index++) {
    expect(seen[index], `percent went backwards: ${seen.join(' -> ')}`).toBeGreaterThanOrEqual(
      seen[index - 1]
    )
  }
  expect(Math.max(...seen)).toBeGreaterThan(10)
  expect(sawIndeterminate).toBe(true)
  expect(expandedLog).toBe(true)
  expect(maxStepsDone, 'step rail marks finished stages').toBeGreaterThanOrEqual(2)
  expect(currentStepLabels.size, 'the current step moves forward').toBeGreaterThanOrEqual(2)

  // Elapsed clock ticks (mm:ss) while the job runs.
  const clockParts = (text: string): string => text.match(/\d{1,2}:\d{2}/g)?.pop() ?? ''
  expect(clockParts(firstClock)).toMatch(/^\d{1,2}:\d{2}$/)
  expect(clockParts(secondClock)).not.toBe(clockParts(firstClock))
  await page.waitForSelector('.result', { timeout: 90_000 })

  // ---- cancel a second job from the progress header
  await page.locator('.sidebar__new').click()
  await waitForHome(page)
  await pickAndStart(page)
  await expect(page.locator('.workorder')).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'progress-before-cancel.png') })
  await page.locator('.workorder__head').getByRole('button', { name: 'إيقاف المعالجة' }).click()

  await expect(page.locator('.job-alert')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.job-alert h3')).toHaveText('أُلغيت المعالجة')
  await expect(page.locator('.job-alert p')).toContainText('أوقفت')
  await expect(page.locator('.workorder__head .badge')).toContainText('أُلغيت المعالجة')
  await page.screenshot({ path: join(SHOTS, 'progress-cancelled.png') })

  assertNoRuntimeErrors(errors)
})

/* ----------------------------------------------------------------- result */

test('result: transcript, speakers, summary order, audio, share menu and exports', async () => {
  const { app, page, dataDir, audioPath, errors } = await launch('result')
  await waitForHome(page)
  await stubPickAudio(app, audioPath)
  await pickAndStart(page)

  // Mock mode has no enhanced audio file; add one before the job finishes so
  // the real export path (audio -> m4a) can be exercised too.
  const jobId = await jobIdOfNewest(page)
  expect(jobId).not.toBe('')
  await writeFile(join(dataDir, 'jobs', jobId, 'enhanced.m4a'), Buffer.alloc(4096, 1))

  await page.waitForSelector('.result', { timeout: 90_000 })
  await expect(page.locator('.result__titleblock')).toBeVisible()
  await expect(page.locator('.result__tb-title')).toContainText('اجتماع فريق المنتج')
  await expect(page.locator('.result__cells .tb-cell')).toHaveCount(6)

  // ---- share menu: exactly three items
  await page.locator('.share-wrap > button').click()
  const items = page.locator('.share-menu [role="menuitem"]')
  await expect(items).toHaveCount(3)
  await expect(items.nth(0)).toContainText('تنزيل الصوت المحسّن')
  await expect(items.nth(1)).toContainText('تنزيل التفريغ النصي')
  await expect(items.nth(2)).toContainText('تنزيل الصفحة الكاملة')
  await page.screenshot({ path: join(SHOTS, 'result-share-menu.png') })
  await page.keyboard.press('Escape')
  await expect(page.locator('.share-menu')).toHaveCount(0)

  // ---- transcript iframe
  const frame = page.frameLocator('.result__frame iframe')
  await expect(frame.locator('.chunk').first()).toBeVisible()
  const chunkCount = await frame.locator('.chunk').count()
  expect(chunkCount).toBeGreaterThan(3)

  const speakerColors = await frame.locator('body').evaluate(() => {
    const read = (selector: string): string => {
      const element = document.querySelector(selector)
      return element ? getComputedStyle(element).borderBottomColor : ''
    }
    return { a: read('.chunk.sA'), b: read('.chunk.sB') }
  })
  expect(speakerColors.a).not.toBe('')
  expect(speakerColors.b).not.toBe('')
  expect(speakerColors.a).not.toBe(speakerColors.b)

  const summaryBeforeTranscript = await frame.locator('body').evaluate(() => {
    const summary = document.querySelector('#recording-summary')
    const transcript = document.querySelector('main')
    if (!summary || !transcript) return null
    return {
      summaryTop: summary.getBoundingClientRect().top,
      transcriptTop: transcript.getBoundingClientRect().top,
      sectionOrder: Array.from(document.body.children).indexOf(summary) <
        Array.from(document.body.children).indexOf(transcript)
    }
  })
  expect(summaryBeforeTranscript).not.toBeNull()
  expect(summaryBeforeTranscript!.summaryTop).toBeLessThan(
    summaryBeforeTranscript!.transcriptTop
  )
  expect(summaryBeforeTranscript!.sectionOrder).toBe(true)

  await expect(frame.locator('.playerbar')).toBeVisible()
  await expect(frame.locator('audio')).toHaveCount(1)

  // ---- speaker strip: pinned with the player, names editable in place
  const chips = frame.locator('.pb-speakers .spk')
  await expect(chips.first()).toBeVisible()
  expect(await frame.locator('.pb-speakers').evaluate((el) => el.closest('.playerbar') !== null)).toBe(
    true
  )
  expect(
    await frame.locator('body').evaluate(() => getComputedStyle(document.querySelector('.playerbar')!).position)
  ).toBe('sticky')

  const originalChip = (await chips.first().innerText()).trim()

  // Clicking a chip swaps its label for a text field. The strip sits at the
  // bottom edge of the frame, so bring it into view first; a click that lands
  // while the page is still settling is retried once.
  const openEditor = async (): Promise<void> => {
    const chip = chips.first()
    await chip.scrollIntoViewIfNeeded()
    await chip.click()
    if ((await frame.locator('.pb-speakers .spk__input').count()) === 0) {
      await chip.click()
    }
  }

  await openEditor()
  const nameInput = frame.locator('.pb-speakers .spk__input')
  await expect(nameInput).toBeVisible()
  await nameInput.fill('د. سارة')
  await nameInput.press('Enter')
  await expect(chips.first()).toContainText('د. سارة')
  expect(originalChip).not.toBe('د. سارة')

  // The rename is persisted in the job and mirrored into the page file, so a
  // re-render, a restart or an exported copy keeps it.
  await expect
    .poll(
      () => {
        try {
          const meta = JSON.parse(readFileSync(join(dataDir, 'jobs', jobId, 'meta.json'), 'utf8'))
          return meta.speakerNames?.A ?? ''
        } catch {
          return ''
        }
      },
      { timeout: 15_000 }
    )
    .toBe('د. سارة')
  await expect
    .poll(() => readFileSync(join(dataDir, 'jobs', jobId, 'transcript.html'), 'utf8'), {
      timeout: 15_000
    })
    .toContain('د. سارة')

  // A long name must grow the strip and push its neighbours, never overflow it.
  await openEditor()
  await frame.locator('.pb-speakers .spk__input').fill('د. سارة عبد الرحمن السيد')
  await frame.locator('.pb-speakers .spk__input').press('Enter')
  const strip = await frame.locator('.pb-speakers').evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    height: el.getBoundingClientRect().height
  }))
  expect(strip.scrollWidth - strip.clientWidth).toBeLessThanOrEqual(1)
  expect(strip.height).toBeGreaterThan(20)

  // Restoring the letter drops the custom name again.
  await openEditor()
  await frame.locator('.pb-speakers .spk__input').fill(originalChip)
  await frame.locator('.pb-speakers .spk__input').press('Enter')
  await expect(chips.first()).toHaveText(originalChip)

  const transcriptText = await frame.locator('.txt').first().innerText()
  expect(transcriptText).toMatch(/[\u0600-\u06FF]/)

  // ---- export all three artifacts through the real IPC handler
  const exportDir = join(dataDir, 'exports')
  await mkdir(exportDir, { recursive: true })
  const targets = [
    join(exportDir, 'enhanced-audio.m4a'),
    join(exportDir, 'transcript.txt'),
    join(exportDir, 'transcript.html')
  ]
  await app.evaluate(({ dialog }, paths) => {
    const scope = globalThis as unknown as { __tafreeghSaveQueue?: string[] }
    scope.__tafreeghSaveQueue = paths.slice()
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: (scope.__tafreeghSaveQueue ?? []).shift() ?? ''
    })
  }, targets)

  for (let index = 0; index < 3; index++) {
    await page.locator('.share-wrap > button').click()
    const menuItems = page.locator('.share-menu [role="menuitem"]')
    await expect(menuItems).toHaveCount(3)
    await menuItems.nth(index).click()
    await expect(page.locator('.share-menu')).toHaveCount(0, { timeout: 15_000 })
    await expect(page.locator('.toast--success').last()).toContainText('تم حفظ الملف')
    await expect
      .poll(() => (existsSync(targets[index]) ? statSync(targets[index]).size : 0), {
        timeout: 15_000
      })
      .toBeGreaterThan(0)
  }

  const exportedHtml = await readFile(targets[2], 'utf8')
  expect(exportedHtml.indexOf('id="recording-summary"')).toBeGreaterThan(-1)
  expect(exportedHtml.indexOf('id="recording-summary"')).toBeLessThan(
    exportedHtml.indexOf('<main>')
  )
  expect(exportedHtml).toContain('id="ui-player-js"')
  expect((await readFile(targets[1], 'utf8')).length).toBeGreaterThan(50)

  // ---- recent list on home reflects the finished recording
  await page.locator('.sidebar__new').click()
  await waitForHome(page)
  await expect(page.locator('.recent-card')).toHaveCount(1)
  await page.locator('.recent-card').first().click()
  await expect(page.locator('.result')).toBeVisible()

  assertNoRuntimeErrors(errors)
})

/* --------------------------------------------------------------- settings */

test('settings: recommended artifact, providers, test spinner, language switch', async () => {
  const { app, page, dataDir, errors } = await launch('settings')
  await waitForHome(page)
  await stubStatus(app, firstRunStatus(dataDir, { completed: true, phase: 'done' }))
  await page.reload()
  await waitForHome(page)

  await page.locator('.sidebar__settings').click()
  await page.waitForSelector('.settings__title')
  await expect(page.locator('.settings__title')).toHaveText('الإعدادات')

  // The engine status names the backend it actually uses. It used to read
  // "CUDA: unavailable" while the GPU row right above showed a working card.
  const backendRow = page.locator('.status-row').filter({ hasText: 'Vulkan' })
  await expect(backendRow).toHaveCount(1)
  await expect(backendRow.locator('.status-dot--ok')).toHaveCount(1)
  await expect(page.locator('.status-row').filter({ hasText: 'CUDA غير متاح' })).toHaveCount(0)

  // Installed artifact (Q4_K_M) differs from the one this device should use.
  const firstModel = page.locator('.model-card').first()
  await expect(firstModel.locator('.model-row__sub')).toContainText('Jais-ASR Q4_K_M (GGUF)')
  await expect(firstModel.locator('.model-row__recommended')).toContainText('الموصى به لجهازك')
  await expect(firstModel.locator('.model-row__recommended')).toContainText('Q8_0 GGUF')
  await expect(firstModel.locator('.model-row__actions .btn').first()).toHaveText(
    /استبدال بالنسخة الموصى بها/
  )
  await expect(firstModel.locator('.badge')).toContainText('موجود')

  // Two installed engine models: the ASR model and the diarizer. The summary
  // model lives in the provider panel, not here.
  await expect(page.locator('.model-card')).toHaveCount(2)
  await expect(page.locator('.provider-card')).toHaveCount(20)
  await expect(page.locator('.provider-group__label').first()).toContainText('محلي')
  await expect(page.locator('.provider-group__label').last()).toContainText('سحابي')
  await page.screenshot({ path: join(SHOTS, 'settings-recommended.png') })

  // Test connection: stubbed latency so the busy spinner is observable.
  // Pick the local Ollama card explicitly so the check does not depend on
  // whichever provider the default settings happen to hold.
  await page
    .locator('.provider-grid')
    .first()
    .locator('.provider-card')
    .filter({ hasText: 'أولاما' })
    .click()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('providers:test')
    ipcMain.handle('providers:test', async () => {
      await new Promise((resolve) => setTimeout(resolve, 900))
      return { ok: true, latencyMs: 42 }
    })
  })
  const testButton = page.locator('.config-actions .btn').nth(1)
  await testButton.click()
  await expect(page.locator('.config-actions .spinner')).toBeVisible()
  await expect(testButton).toBeDisabled()
  const spinnerAnimation = await page
    .locator('.config-actions .spinner')
    .evaluate((element) =>
      element.getAnimations().map((animation) => ({
        name: animation.animationName,
        state: animation.playState
      }))
    )
  expect(spinnerAnimation).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'spin', state: 'running' })])
  )
  await page.screenshot({ path: join(SHOTS, 'settings-testing.png') })
  await expect(page.locator('.config-actions .config-note')).toContainText('الاتصال ناجح')
  await expect(testButton).toBeEnabled()

  // Language switch flips the whole document to LTR English and back.
  const languages = page.locator('.settings .lang-select button')
  await languages.nth(1).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe('ltr')
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
  await expect(page.locator('.settings__title')).toHaveText('Settings')
  await expect(page.locator('.sidebar__new')).toContainText('New recording')
  await expect(page.locator('.app-topbar')).toContainText('Settings')
  await page.screenshot({ path: join(SHOTS, 'settings-english.png') })

  await languages.nth(0).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe('rtl')
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('ar')
  await expect(page.locator('.settings__title')).toHaveText('الإعدادات')
  await expect(page.locator('.sidebar__new')).toContainText('تسجيل جديد')

  const overflow = await page.evaluate(() => {
    const workspace = document.querySelector('.workspace') as HTMLElement
    return {
      doc: document.documentElement.scrollWidth,
      width: innerWidth,
      workspace: workspace.scrollWidth - workspace.clientWidth
    }
  })
  expect(overflow.doc).toBeLessThanOrEqual(overflow.width + 1)
  expect(overflow.workspace).toBeLessThanOrEqual(1)

  assertNoRuntimeErrors(errors)
})

/* ------------------------------------------------- settings: token + progress */

test('settings: hugging face token field and live download progress', async () => {
  const { app, page, dataDir, errors } = await launch('settings-hf')
  await waitForHome(page)
  await stubStatus(app, firstRunStatus(dataDir, { completed: true, phase: 'done' }))
  await page.reload()
  await waitForHome(page)

  await page.locator('.sidebar__settings').click()
  await page.waitForSelector('.settings__title')

  // The token is optional, so the field is always offered with a status note.
  const tokenInput = page.locator('#settings-hf-token')
  await expect(tokenInput).toBeVisible()
  await expect(page.locator('.hf-token .label-ar')).toContainText('Hugging Face')
  await expect(page.locator('.hf-token')).toContainText('لا يوجد رمز')

  const saveToken = page.locator('.hf-token .key-row .btn').first()
  await expect(saveToken).toBeDisabled()
  await tokenInput.fill('short')
  await expect(saveToken).toBeDisabled()
  await tokenInput.fill('hf_notarealtokenbutlongenough')
  await expect(saveToken).toBeEnabled()

  // A download started from Settings must show real bytes, not a bare spinner.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('setup:download-model')
    ipcMain.handle('setup:download-model', () => new Promise(() => {}))
  })

  const downloadButton = page.locator('.model-card').first().locator('.model-row__actions .btn').first()
  await downloadButton.click()
  const dialog = page.locator('.modal[role="alertdialog"]')
  await expect(dialog).toBeVisible()
  await dialog.locator('.modal__actions .btn--primary').click()

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.webContents.send('setup:event', {
      phase: 'jais',
      pct: 42,
      indeterminate: false,
      message: 'تنزيل نموذج التفريغ (Q4_K_M GGUF)',
      bytesDone: 1_550_000_000,
      bytesTotal: 3_700_000_000
    })
  })

  const bar = page.locator('.download-progress')
  await expect(bar).toBeVisible()
  await expect(bar).toContainText('42%')
  await expect(bar).toContainText('Q4_K_M')
  await expect(bar.locator('.progressbar__fill')).toBeVisible()
  // The fill animates (550 ms) up to the reported percentage.
  const fillRatio = (): Promise<number> =>
    bar.locator('.progressbar').evaluate((element) => {
      const track = element.getBoundingClientRect()
      const inner = element.querySelector('.progressbar__fill')!.getBoundingClientRect()
      return track.width > 0 ? inner.width / track.width : 0
    })
  await expect.poll(fillRatio, { timeout: 5_000 }).toBeGreaterThan(0.3)
  expect(await fillRatio()).toBeLessThan(0.6)
  await page.screenshot({ path: join(SHOTS, 'settings-hf-progress.png') })

  assertNoRuntimeErrors(errors)
})

/* ----------------------------------------------------------------- layout */

test('layout at 1280/1024/900: no clipping, no horizontal scroll, Arabic intact', async () => {
  const { app, page, audioPath, errors } = await launch('layout')
  await waitForHome(page)
  await stubPickAudio(app, audioPath)

  const sizes: Array<[number, number]> = [
    [1280, 800],
    [1024, 700],
    [900, 640]
  ]

  async function inspect(view: string): Promise<void> {
    const metrics = await page.evaluate(() => {
      const rect = (selector: string): DOMRect | null =>
        document.querySelector(selector)?.getBoundingClientRect() ?? null
      const workspace = document.querySelector('.workspace') as HTMLElement
      const sidebar = rect('.sidebar')
      const topbar = rect('.app-topbar')
      const workspaceRect = rect('.workspace')
      const headline = document.querySelector('.home__headline') as HTMLElement | null
      const selectors = [
        '.home__hero',
        '.home__grid',
        '.dropzone',
        '.transcribe-options',
        '.session-summary',
        '.how',
        '.recent-list',
        '.settings__hero',
        '.settings-section',
        '.model-card',
        '.provider-grid',
        '.result__titleblock',
        '.result__cells',
        '.result__toolbar',
        '.result__frame-wrap'
      ]
      const boxes = selectors
        .map((selector) => {
          const element = document.querySelector(selector) as HTMLElement | null
          if (!element) return null
          const box = element.getBoundingClientRect()
          return {
            selector,
            left: box.left,
            right: box.right,
            width: box.width,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth
          }
        })
        .filter(Boolean) as Array<{
        selector: string
        left: number
        right: number
        width: number
        scrollWidth: number
        clientWidth: number
      }>

      return {
        innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        workspace: {
          left: workspaceRect?.left ?? 0,
          right: workspaceRect?.right ?? 0,
          scrollWidth: workspace.scrollWidth,
          clientWidth: workspace.clientWidth
        },
        sidebar: sidebar ? { left: sidebar.left, right: sidebar.right, width: sidebar.width } : null,
        topbarBottom: topbar?.bottom ?? 0,
        workspaceTop: workspaceRect?.top ?? 0,
        headlineLetterSpacing: headline ? getComputedStyle(headline).letterSpacing : '',
        headlineFont: headline ? getComputedStyle(headline).fontFamily : '',
        headlineScroll: headline ? headline.scrollWidth - headline.clientWidth : 0,
        boxes
      }
    })

    expect(metrics.docScrollWidth, `${view}: page overflows horizontally`).toBeLessThanOrEqual(
      metrics.innerWidth + 1
    )
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1)
    expect(
      metrics.workspace.scrollWidth - metrics.workspace.clientWidth,
      `${view}: workspace has a horizontal scrollbar`
    ).toBeLessThanOrEqual(1)
    expect(metrics.sidebar).not.toBeNull()
    expect(metrics.sidebar!.right).toBeLessThanOrEqual(metrics.innerWidth + 1)
    expect(metrics.sidebar!.left).toBeGreaterThanOrEqual(metrics.workspace.right - 1)
    expect(metrics.topbarBottom).toBeLessThanOrEqual(metrics.workspaceTop + 1)

    for (const box of metrics.boxes) {
      expect(box.width, `${view}: ${box.selector} collapsed`).toBeGreaterThan(0)
      expect(box.left, `${view}: ${box.selector} clipped on the left`).toBeGreaterThanOrEqual(-1)
      expect(box.right, `${view}: ${box.selector} clipped on the right`).toBeLessThanOrEqual(
        metrics.innerWidth + 1
      )
      expect(
        box.scrollWidth - box.clientWidth,
        `${view}: ${box.selector} overflows itself`
      ).toBeLessThanOrEqual(1)
    }

    if (view === 'home') {
      expect(metrics.headlineLetterSpacing === 'normal' || metrics.headlineLetterSpacing === '0px').toBe(
        true
      )
      expect(metrics.headlineFont.toLowerCase()).toContain('cairo')
      expect(metrics.headlineScroll).toBeLessThanOrEqual(1)
    }
  }

  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(350)
    await waitForHome(page)
    await inspect('home')
    await page.screenshot({ path: join(SHOTS, `layout-${width}-home.png`) })

    await page.locator('.sidebar__settings').click()
    await page.waitForSelector('.settings__title')
    await page.waitForTimeout(250)
    await inspect('settings')
    await page.screenshot({ path: join(SHOTS, `layout-${width}-settings.png`) })

    await page.locator('.sidebar__new').click()
    await waitForHome(page)
  }

  // One real run so the result view is covered at every size too.
  await page.setViewportSize({ width: 1280, height: 800 })
  await pickAndStart(page)
  await page.waitForSelector('.result', { timeout: 90_000 })

  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(500)
    await expect(page.locator('.result')).toBeVisible()
    await inspect('result')

    const frame = page.frameLocator('.result__frame iframe')
    await expect(frame.locator('.chunk').first()).toBeVisible()
    await page.screenshot({ path: join(SHOTS, `layout-${width}-result.png`) })
  }

  assertNoRuntimeErrors(errors)
})
