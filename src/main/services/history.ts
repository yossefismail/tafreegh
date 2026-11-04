import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JobStatus, JobSummary } from '../../shared/types'
import { getPaths, jobDir } from './paths'

const ACTIVE: JobStatus[] = ['queued', 'running', 'summarizing', 'rendering']

const STATUSES: JobStatus[] = [
  'queued',
  'running',
  'summarizing',
  'rendering',
  'done',
  'error',
  'cancelled'
]

/**
 * `history.json` is user-editable and older builds wrote fewer fields. Fill the
 * gaps here so a missing `speakers` array cannot crash the detail view later
 * (`speakers.length` in the render note) or the job renderer.
 */
function normaliseJob(job: JobSummary): JobSummary {
  const now = new Date().toISOString()
  return {
    ...job,
    title: typeof job.title === 'string' && job.title ? job.title : 'تسجيل',
    sourceName: typeof job.sourceName === 'string' ? job.sourceName : '',
    sourcePath: typeof job.sourcePath === 'string' ? job.sourcePath : '',
    createdAt: typeof job.createdAt === 'string' ? job.createdAt : now,
    updatedAt: typeof job.updatedAt === 'string' ? job.updatedAt : now,
    status: STATUSES.includes(job.status) ? job.status : 'error',
    stage: job.stage ?? 'done',
    speakers: Array.isArray(job.speakers)
      ? job.speakers.filter((speaker): speaker is string => typeof speaker === 'string')
      : [],
    language: typeof job.language === 'string' && job.language ? job.language : 'ar',
    hasSummary: Boolean(job.hasSummary),
    files: job.files && typeof job.files === 'object' ? job.files : {}
  }
}

export class HistoryStore {
  private items: JobSummary[] = []

  constructor() {
    this.load()
    this.reconcile()
    this.markInterrupted()
  }

  private load(): void {
    const file = getPaths().history
    if (!existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        this.items = parsed
          .filter((item): item is JobSummary => {
            return Boolean(item && typeof item === 'object' && 'id' in item && 'createdAt' in item)
          })
          .map((item) => normaliseJob(item))
      }
    } catch {
      this.items = []
    }
  }

  private reconcile(): void {
    const root = getPaths().jobs
    if (!existsSync(root)) return
    const known = new Set(this.items.map((item) => item.id))
    for (const name of readdirSync(root)) {
      if (known.has(name)) continue
      const metaPath = join(jobDir(name), 'meta.json')
      if (!existsSync(metaPath)) continue
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as JobSummary
        if (meta?.id) this.items.push(normaliseJob(meta))
      } catch {
        // ignore malformed metadata
      }
    }
    this.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    this.persist()
  }

  private markInterrupted(): void {
    let changed = false
    for (const item of this.items) {
      if (ACTIVE.includes(item.status)) {
        item.status = 'error'
        item.error = 'توقف التطبيق أثناء المعالجة. أعد المحاولة.'
        item.updatedAt = new Date().toISOString()
        changed = true
      }
    }
    if (changed) this.persist()
  }

  list(): JobSummary[] {
    return [...this.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  get(id: string): JobSummary | undefined {
    return this.items.find((item) => item.id === id)
  }

  upsert(job: JobSummary): JobSummary {
    const index = this.items.findIndex((item) => item.id === job.id)
    if (index >= 0) this.items[index] = job
    else this.items.push(job)
    this.persist()
    return job
  }

  remove(id: string): void {
    this.items = this.items.filter((item) => item.id !== id)
    this.persist()
  }

  private persist(): void {
    const paths = getPaths()
    const file = paths.history
    const tmp = file + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch {
      // never crash the app for an index write failure
    }
  }
}
