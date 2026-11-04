import { dialog, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type {
  ExportKind,
  ExportResult,
  JobEvent,
  JobProgress,
  JobSummary,
  JobTranscript,
  Settings,
  StageId,
  StartJobInput
} from '../../shared/types'
import { isAudioPath } from '../../shared/languages'
import type { HistoryStore } from './history'
import { engineJaisDir } from './engine'
import { jobDir } from './paths'
import { ProcessRunner } from './process'
import type { ProvidersService } from './providers'
import { PROVIDERS } from './providers'
import type { SettingsStore } from './settings'
import { summarizeTranscript, type Moment, type SummaryResult } from './summarize'
import { CancelledError, runWorker } from './worker'

interface WorkerDone {
  html?: string
  txt?: string
  json?: string
  audio?: string
  speakers?: string[]
  duration?: number
  speechStart?: number
  speechEnd?: number
  windows?: number
  elapsed?: number
}

interface Active {
  id: string
  runner: ProcessRunner
  cancelled: boolean
  startedAt: number
  log: ReturnType<typeof createWriteStream>
}

function nowIso(): string {
  return new Date().toISOString()
}

function newId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

function safeName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 120) || 'recording'
  )
}

function fmtDuration(seconds?: number): string {
  if (!seconds || seconds < 1) return '00:00'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function fileSize(path?: string): number {
  if (!path || !existsSync(path)) return 0
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function dateLabel(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yyyy = date.getFullYear()
  return `${dd}·${mm}·${yyyy}`
}

function splitTitle(title: string): string {
  if (title.length <= 42) return title
  const words = title.split(' ')
  let first = ''
  let index = 0
  while (index < words.length && (first + ' ' + words[index]).trim().length <= 34) {
    first = (first + ' ' + words[index]).trim()
    index++
  }
  const second = words.slice(index).join(' ')
  if (!first || !second) return title
  return `${first}|${second}`
}

function noteFor(title: string, duration: number | undefined, speakers: string[]): string {
  const count =
    speakers.length === 0
      ? 'متحدثون غير محددين'
      : speakers.length === 1
        ? 'متحدث واحد'
        : speakers.length === 2
          ? 'متحدثان'
          : `${speakers.length} متحدثين`
  const span = `\u2066${fmtDuration(duration)}\u2069`
  return `تفريغ آلي لـ «${title}» — ${span}، ${count}. النص محفوظ كما نُطق، مع الإبقاء على الكلمات الإنجليزية بحروفها اللاتينية.`
}

const NAMES_BLOCK =
  /(<script type="application\/json" id="ui-speaker-names">)([\s\S]*?)(<\/script>)/

/**
 * Speaker names are embedded in the page, so an exported or shared HTML file
 * keeps them without the app. The page also posts edits back here, which keeps
 * meta.json in step so a later re-render does not lose them.
 */
export function writeSpeakerNames(
  htmlPath: string,
  names: Record<string, string>
): boolean {
  if (!htmlPath || !existsSync(htmlPath)) return false
  let html: string
  try {
    html = readFileSync(htmlPath, 'utf8')
  } catch {
    return false
  }
  if (!NAMES_BLOCK.test(html)) return false
  const json = JSON.stringify(names).replace(/</g, '\\u003c')
  const next = html.replace(NAMES_BLOCK, (_match, open, _old, close) => `${open}${json}${close}`)
  if (next === html) return false
  writeFileSync(htmlPath, next, 'utf8')
  return true
}

const STAGE_LABEL: Record<string, string> = {
  decode: 'فك ترميز الصوت',
  enhance: 'تنقية الصوت',
  diarize: 'تمييز المتحدثين',
  load: 'تحميل النموذج',
  transcribe: 'تفريغ الكلام',
  audio: 'تجهيز الصوت',
  artifacts: 'بناء الصفحة',
  summary: 'كتابة الملخص',
  render: 'تنسيق الصفحة'
}

export class JobService {
  private queue: string[] = []
  private active: Active | null = null
  private retrying = new Set<string>()

  constructor(
    private store: HistoryStore,
    private settings: SettingsStore,
    private providers: ProvidersService,
    private onEvent: (event: JobEvent) => void
  ) {}

  list(): JobSummary[] {
    return this.store.list()
  }

  get(id: string): JobSummary | undefined {
    return this.store.get(id)
  }

  private emit(job: JobSummary): void {
    this.onEvent({ type: 'job', job })
  }

  private persist(job: JobSummary): void {
    job.updatedAt = nowIso()
    this.store.upsert(job)
    mkdirSync(jobDir(job.id), { recursive: true })
    writeFileSync(join(jobDir(job.id), 'meta.json'), JSON.stringify(job, null, 2), 'utf8')
    this.emit(job)
  }

  private progress(
    job: JobSummary,
    stage: StageId,
    overall: number,
    message: string,
    indeterminate = false,
    extra: Partial<JobProgress> = {}
  ): void {
    job.stage = stage
    const progress: JobProgress = {
      stage,
      overall: Math.max(0, Math.min(100, Math.round(overall))),
      indeterminate,
      message,
      elapsedMs: this.active?.id === job.id ? Date.now() - this.active.startedAt : undefined,
      ...extra
    }
    job.progress = progress
    this.onEvent({ type: 'progress', jobId: job.id, progress })
  }

  /** Per-recording override falls back to the saved default when absent. */
  private summarizerFor(job: JobSummary): Settings['summarizer'] {
    const base = this.settings.get().summarizer
    if (!job.summarizer) return base
    return {
      ...base,
      provider: job.summarizer.provider,
      model: job.summarizer.model?.trim() || base.model
    }
  }

  private withSummarizer(
    settings: Settings,
    summarizer: Settings['summarizer']
  ): Settings {
    return { ...settings, summarizer }
  }

  async start(input: StartJobInput): Promise<JobSummary> {
    if (!input || typeof input.filePath !== 'string') throw new Error('ملف غير صالح')
    if (!existsSync(input.filePath) || !statSync(input.filePath).isFile()) {
      throw new Error('الملف غير موجود')
    }
    if (!isAudioPath(input.filePath)) throw new Error('صيغة الملف غير مدعومة')
    if (statSync(input.filePath).size < 1024) throw new Error('الملف فارغ أو تالف')

    const id = newId()
    const dir = jobDir(id)
    mkdirSync(dir, { recursive: true })
    const title = basename(input.filePath, extname(input.filePath))
    const language = input.language || this.settings.get().dialect
    const job: JobSummary = {
      id,
      title,
      sourceName: basename(input.filePath),
      sourcePath: input.filePath,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'queued',
      stage: 'queued',
      speakers: [],
      language,
      hasSummary: false,
      summarizer: input.summarizer,
      files: {},
      progress: {
        stage: 'queued',
        overall: 0,
        indeterminate: false,
        message: 'في قائمة الانتظار'
      }
    }
    this.persist(job)
    this.queue.push(id)
    this.pump()
    return job
  }

  private pump(): void {
    if (this.active) return
    const id = this.queue.shift()
    if (!id) return
    const job = this.store.get(id)
    if (!job || job.status === 'cancelled') {
      this.pump()
      return
    }
    const log = createWriteStream(join(jobDir(id), 'job.log'), { flags: 'a' })
    this.active = {
      id,
      runner: new ProcessRunner(),
      cancelled: false,
      startedAt: Date.now(),
      log
    }
    this.execute(job, this.active)
      .catch((error) => {
        // execute handles its own errors; this is a last-resort guard
        console.error(error)
      })
      .finally(() => {
        log.end()
        this.active = null
        this.pump()
      })
  }

  private async execute(job: JobSummary, active: Active): Promise<void> {
    const settings = this.settings.get()
    const logLine = (line: string): void => {
      const text = line.trimEnd()
      if (!text) return
      active.log.write(`[${new Date().toISOString()}] ${text}\n`)
      this.onEvent({ type: 'log', jobId: job.id, line: text.slice(0, 500) })
    }

    try {
      job.status = 'running'
      job.stage = 'decode'
      this.persist(job)
      this.progress(job, 'decode', 2, 'تجهيز الملف الصوتي…', true)

      await runWorker({
        runner: active.runner,
        args: [
          'run',
          '--input',
          job.sourcePath,
          '--job-dir',
          jobDir(job.id),
          '--display-name',
          job.title,
          '--language',
          job.language,
          '--enhance',
          settings.enhance ? '1' : '0',
          '--model-dir',
          engineJaisDir()
        ],
        onEvent: (event) => {
          if (event.type === 'progress') {
            const stage = String(event.stage || 'decode') as StageId
            const overall = Number(event.overall || 0)
            this.progress(
              job,
              stage,
              2 + Math.min(100, overall) * 0.76,
              String(event.message || STAGE_LABEL[stage] || ''),
              Boolean(event.indeterminate),
              {
                window: typeof event.window === 'number' ? event.window : undefined,
                windows: typeof event.windows === 'number' ? event.windows : undefined,
                detail:
                  typeof event.window === 'number' && typeof event.windows === 'number'
                    ? `${event.window} / ${event.windows}`
                    : undefined
              }
            )
          } else if (event.type === 'log') {
            logLine(String(event.message ?? ''))
          }
        },
        onLog: logLine,
        isCancelled: () => active.cancelled
      })

      const done = readWorkerResult(jobDir(job.id))
      const transcript = readTranscript(done.json)
      job.durationSec = transcript.duration
      job.speechStart = transcript.speechStart
      job.speechEnd = transcript.speechEnd
      job.speakers = transcript.speakers
      job.windows = transcript.windows
      job.files = {
        html: done.html,
        txt: done.txt,
        audio: done.audio,
        transcriptJson: done.json
      }
      job.hasSummary = false
      job.summaryError = undefined
      job.status = 'summarizing'
      job.stage = 'summary'
      this.persist(job)

      let summary: SummaryResult | null = null
      const config = this.summarizerFor(job)
      if (config.provider && config.provider !== 'none') {
        this.progress(job, 'summary', 80, 'كتابة الملخص وبنود التنفيذ…', true, {
          detail: `${PROVIDERS.find((p) => p.id === config.provider)?.name ?? config.provider} · ${config.model || 'auto'}`
        })
        try {
          summary = await summarizeTranscript(this.providers, this.withSummarizer(settings, config), transcript, {
            onStatus: (message) =>
              this.progress(job, 'summary', 80, message, true, {
                detail: `${PROVIDERS.find((p) => p.id === config.provider)?.name ?? config.provider} · ${config.model || 'auto'}`
              })
          })
          writeFileSync(join(jobDir(job.id), 'summary.md'), summary.markdown, 'utf8')
          job.hasSummary = true
          job.summaryProvider = summary.provider
          job.summaryModel = summary.model
          job.files.summary = join(jobDir(job.id), 'summary.md')
          logLine(`summary written with ${summary.provider}/${summary.model}`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          job.summaryError = message
          job.hasSummary = false
          logLine(`summary failed: ${message}`)
        }
      } else {
        job.summaryError = undefined
        logLine('summary skipped: no provider configured')
      }
      this.persist(job)

      await this.render(job, summary?.moments ?? [])

      job.status = 'done'
      job.stage = 'done'
      job.sizeBytes =
        fileSize(job.files.audio) + fileSize(job.files.html) + fileSize(job.files.txt)
      job.progress = {
        stage: 'done',
        overall: 100,
        indeterminate: false,
        message: 'اكتمل التفريغ',
        elapsedMs: Date.now() - active.startedAt
      }
      this.persist(job)
      this.onEvent({ type: 'progress', jobId: job.id, progress: job.progress })
    } catch (error) {
      const cancelled = error instanceof CancelledError || active.cancelled
      job.status = cancelled ? 'cancelled' : 'error'
      job.stage = job.status === 'cancelled' ? job.stage : 'done'
      job.error = cancelled
        ? undefined
        : error instanceof Error
          ? error.message
          : String(error)
      if (!job.error && !cancelled) job.error = 'حدث خطأ غير متوقع'
      // recover any partial deliverables
      const html = join(jobDir(job.id), 'transcript.html')
      const txt = join(jobDir(job.id), 'transcript.txt')
      const audio = join(jobDir(job.id), 'enhanced.m4a')
      const json = join(jobDir(job.id), 'transcript.json')
      if (existsSync(html)) job.files.html = html
      if (existsSync(txt)) job.files.txt = txt
      if (existsSync(audio)) job.files.audio = audio
      if (existsSync(json)) job.files.transcriptJson = json
      logLine(job.error ?? 'cancelled')
      this.persist(job)
    }
  }

  private async render(
    job: JobSummary,
    moments: Moment[],
    runner?: ProcessRunner
  ): Promise<void> {
    job.status = 'rendering'
    job.stage = 'render'
    this.persist(job)
    this.progress(job, 'render', 92, 'تجميع الصفحة النهائية…', true)

    const dir = jobDir(job.id)
    let momentsFile: string | undefined
    if (moments.length) {
      momentsFile = join(dir, 'moments.json')
      writeFileSync(momentsFile, JSON.stringify(moments, null, 2), 'utf8')
    }
    const count = this.store.list().length
    // The model cell names the models that actually produced this page: the
    // summarizer by its exact model id, not just "Ollama"/"OpenAI".
    const summarizer = job.summaryModel
      ? job.summaryModel
      : job.summaryProvider
        ? PROVIDERS.find((p) => p.id === job.summaryProvider)?.name ?? job.summaryProvider
        : ''
    const model =
      `Jais-ASR GGUF · Nemotron-3-Diarization` + (summarizer ? ` · ${summarizer}` : '')
    const args = [
      'render',
      '--job-dir',
      dir,
      '--title',
      splitTitle(job.title),
      '--kicker',
      `تسجيل ${String(count).padStart(2, '0')} — فهرس التفريغ`,
      '--note',
      noteFor(job.title, job.durationSec, job.speakers),
      '--project',
      'تفريغ',
      '--date',
      dateLabel(new Date(job.createdAt)),
      '--model',
      model,
      '--heading',
      'التفريغ.',
      '--end',
      fmtDuration(job.speechEnd)
    ]
    if (job.files.summary) args.push('--summary', job.files.summary)
    if (momentsFile) args.push('--moments-file', momentsFile)
    if (job.speakerNames && Object.keys(job.speakerNames).length) {
      const namesFile = join(dir, 'speaker-names.json')
      writeFileSync(namesFile, JSON.stringify(job.speakerNames, null, 2), 'utf8')
      args.push('--speaker-names', namesFile)
    }

    const active = this.active
    const childRunner = runner ?? active?.runner
    if (!childRunner) throw new Error('لا توجد مهمة نشطة')
    const appendLog = (line: string): void => {
      appendFileSync(
        join(dir, 'job.log'),
        `[${new Date().toISOString()}] ${line}\n`,
        'utf8'
      )
    }
    await runWorker({
      runner: childRunner,
      args,
      onEvent: (event) => {
        if (event.type === 'progress') {
          const overall = Number(event.overall || 0)
          this.progress(
            job,
            'render',
            92 + Math.min(100, overall) * 0.07,
            String(event.message || 'تجميع الصفحة النهائية…'),
            Boolean(event.indeterminate)
          )
        } else if (event.type === 'log') {
          appendLog(String(event.message ?? ''))
        }
      },
      onLog: appendLog,
      isCancelled: () => this.active?.id === job.id && this.active.cancelled
    })
    job.files.html = join(dir, 'transcript.html')
    job.files.txt = join(dir, 'transcript.txt')
    this.persist(job)
  }

  /**
   * The user typed a speaker name into the transcript page. Keep it in
   * meta.json, mirror it into transcript.html (so the file itself travels with
   * the names), and emit the job. `updatedAt` is deliberately untouched: it is
   * part of the result iframe key, and bumping it would reload the page the
   * user is still typing in.
   */
  renameSpeakers(id: string, names: Record<string, string>): JobSummary {
    const job = this.store.get(id)
    if (!job) throw new Error('المهمة غير موجودة')
    const clean: Record<string, string> = {}
    for (const [rawKey, rawValue] of Object.entries(names ?? {})) {
      const key = String(rawKey).trim().toUpperCase()
      const value = String(rawValue ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40)
      if (/^[A-H]$/.test(key) && value) clean[key] = value
    }
    job.speakerNames = clean
    mkdirSync(jobDir(job.id), { recursive: true })
    writeFileSync(join(jobDir(job.id), 'meta.json'), JSON.stringify(job, null, 2), 'utf8')
    if (job.files.html) writeSpeakerNames(job.files.html, clean)
    this.emit(job)
    return job
  }

  cancel(id: string): JobSummary {
    const job = this.store.get(id)
    if (!job) throw new Error('المهمة غير موجودة')
    if (this.active?.id === id) {
      this.active.cancelled = true
      this.active.runner.cancel()
      job.status = 'cancelled'
      job.progress = {
        stage: job.stage,
        overall: job.progress?.overall ?? 0,
        indeterminate: false,
        message: 'أُلغيت المعالجة'
      }
      this.persist(job)
      return job
    }
    this.queue = this.queue.filter((queued) => queued !== id)
    if (job.status === 'queued') {
      job.status = 'cancelled'
      job.progress = {
        stage: 'queued',
        overall: 0,
        indeterminate: false,
        message: 'أُلغيت المعالجة'
      }
      this.persist(job)
    }
    return job
  }

  async retrySummary(id: string): Promise<JobSummary> {
    const job = this.store.get(id)
    if (!job) throw new Error('المهمة غير موجودة')
    if (this.retrying.has(id)) return job
    // A second writer in the same job folder would fight the active job (and
    // could delete files under it). Wait for the queue instead.
    if (this.active?.id === id || job.status === 'queued' || job.status === 'running') {
      throw new Error('انتظر انتهاء معالجة التسجيل ثم أعد كتابة الملخص.')
    }
    const jsonPath = job.files.transcriptJson ?? join(jobDir(id), 'transcript.json')
    if (!existsSync(jsonPath)) throw new Error('لا يوجد تفريغ محفوظ لإعادة الملخص')
    const settings = this.settings.get()
    const config = this.summarizerFor(job)
    if (!config.provider || config.provider === 'none') {
      throw new Error('اختر مزود الملخص من الإعدادات أولًا')
    }
    this.retrying.add(id)
    try {
      const transcript = readTranscript(jsonPath)
      job.status = 'summarizing'
      job.stage = 'summary'
      job.summaryError = undefined
      this.persist(job)
      this.onEvent({
        type: 'progress',
        jobId: id,
        progress: {
          stage: 'summary',
          overall: 80,
          indeterminate: true,
          message: 'إعادة كتابة الملخص…'
        }
      })
      const summary = await summarizeTranscript(
        this.providers,
        this.withSummarizer(settings, config),
        transcript,
        {
          onStatus: (message) => {
            this.progress(job, 'summary', 80, message, true)
          }
        }
      )
      writeFileSync(join(jobDir(id), 'summary.md'), summary.markdown, 'utf8')
      job.hasSummary = true
      job.summaryProvider = summary.provider
      job.summaryModel = summary.model
      job.files.summary = join(jobDir(id), 'summary.md')
      await this.render(job, summary.moments, new ProcessRunner())
      job.status = 'done'
      job.stage = 'done'
      job.sizeBytes =
        fileSize(job.files.audio) + fileSize(job.files.html) + fileSize(job.files.txt)
      job.progress = {
        stage: 'done',
        overall: 100,
        indeterminate: false,
        message: 'اكتمل التفريغ'
      }
      this.persist(job)
      return job
    } catch (error) {
      job.status = 'done'
      job.stage = 'done'
      job.summaryError = error instanceof Error ? error.message : String(error)
      this.persist(job)
      throw error
    } finally {
      this.retrying.delete(id)
    }
  }

  remove(id: string): void {
    const job = this.store.get(id)
    if (!job) return
    if (this.active?.id === id) throw new Error('أوقف المعالجة قبل حذف المهمة')
    if (this.retrying.has(id)) throw new Error('انتظر انتهاء كتابة الملخص ثم احذف المهمة')
    if (this.queue.includes(id)) this.queue = this.queue.filter((queued) => queued !== id)
    rmSync(jobDir(id), { recursive: true, force: true })
    this.store.remove(id)
    this.onEvent({ type: 'removed', jobId: id })
  }

  async export(id: string, kind: ExportKind): Promise<ExportResult> {
    const job = this.store.get(id)
    if (!job) return { ok: false, error: 'المهمة غير موجودة' }
    const map = {
      audio: { path: job.files.audio, suffix: ' - enhanced audio.m4a' },
      txt: { path: job.files.txt, suffix: ' - transcript.txt' },
      html: { path: job.files.html, suffix: ' - transcript.html' },
      summary: { path: job.files.summary, suffix: ' - summary.md' }
    } as const
    const entry = map[kind]
    if (!entry?.path || !existsSync(entry.path)) {
      return { ok: false, error: 'الملف غير متاح بعد' }
    }
    const defaultPath = join(
      homedir(),
      'Downloads',
      safeName(job.title) + entry.suffix
    )
    const result = await dialog.showSaveDialog({
      title: 'حفظ الملف',
      defaultPath,
      buttonLabel: 'حفظ',
      filters: [
        kind === 'html'
          ? { name: 'صفحة ويب', extensions: ['html'] }
          : kind === 'txt'
            ? { name: 'نص', extensions: ['txt'] }
            : kind === 'audio'
              ? { name: 'صوت', extensions: ['m4a'] }
              : { name: 'ماركداون', extensions: ['md'] }
      ]
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      copyFileSync(entry.path, result.filePath)
      return { ok: true, path: result.filePath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async openOutput(id: string): Promise<void> {
    const job = this.store.get(id)
    if (!job?.files.html || !existsSync(job.files.html)) throw new Error('لا توجد صفحة جاهزة')
    await shell.openPath(job.files.html)
  }

  reveal(id: string): void {
    const job = this.store.get(id)
    if (!job) throw new Error('المهمة غير موجودة')
    const target = job.files.html && existsSync(job.files.html) ? job.files.html : jobDir(id)
    shell.showItemInFolder(target)
  }
}

function readWorkerResult(dir: string): WorkerDone {
  const html = join(dir, 'transcript.html')
  const txt = join(dir, 'transcript.txt')
  const audio = join(dir, 'enhanced.m4a')
  return {
    // Only advertise deliverables the worker actually wrote; openOutput and
    // export treat a present path as a promise the file exists.
    html: existsSync(html) ? html : undefined,
    txt: existsSync(txt) ? txt : undefined,
    json: join(dir, 'transcript.json'),
    audio: existsSync(audio) ? audio : undefined
  }
}

function readTranscript(path?: string): JobTranscript {
  if (!path || !existsSync(path)) throw new Error('ملف التفريغ غير موجود')
  const raw = JSON.parse(readFileSync(path, 'utf8')) as JobTranscript
  if (!raw || !Array.isArray(raw.lines)) throw new Error('ملف التفريغ غير صالح')
  return raw
}
