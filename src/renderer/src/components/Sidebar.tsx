import { useMemo, useState } from 'react'
import type { JobSummary } from '@shared/types'
import { useApp, useLanguage, useT } from '../store'
import { BrandMark, Icon } from './Icon'
import { ConfirmDialog } from './Overlays'
import { dateGroup, formatDuration, formatTime, speakerLabel } from '../lib/format'
import type { MessageKey } from '../i18n'

function statusClass(job: JobSummary): string {
  if (job.status === 'done') return 'is-done'
  if (job.status === 'error') return 'is-error'
  if (['queued', 'running', 'summarizing', 'rendering'].includes(job.status)) return 'is-live'
  return ''
}

export function Sidebar(): React.JSX.Element {
  const jobs = useApp((state) => state.jobs)
  const activeId = useApp((state) => state.activeId)
  const setup = useApp((state) => state.setup)
  const view = useApp((state) => state.view)
  const selectJob = useApp((state) => state.selectJob)
  const setView = useApp((state) => state.setView)
  const removeJob = useApp((state) => state.removeJob)
  const t = useT()
  const lang = useLanguage()
  const [query, setQuery] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<JobSummary | null>(null)

  const ordered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return jobs.filter((job) => !q || job.title.toLowerCase().includes(q) || job.sourceName.toLowerCase().includes(q))
  }, [jobs, query])

  const groups = useMemo(() => {
    const buckets: Record<string, JobSummary[]> = {
      today: [],
      yesterday: [],
      thisWeek: [],
      older: []
    }
    for (const job of ordered) buckets[dateGroup(job.createdAt)].push(job)
    return buckets
  }, [ordered])

  const indexOf = useMemo(() => {
    const map = new Map<string, number>()
    jobs.forEach((job, index) => map.set(job.id, index))
    return map
  }, [jobs])

  const ready = Boolean(setup?.completed)
  const variant = setup?.models?.jais?.variant === 'gguf-q8' ? 'Q8_0' : 'Q4_K_M'
  const modelLabel = ready ? `JAIS ${variant} · NEMOTRON-3` : t('engineNotReady')

  return (
    <aside className="sidebar" aria-label={t('history')}>
      <div className="sidebar__head">
        <BrandMark size={28} />
        <div className="sidebar__brand">
          <span className="sidebar__wordmark">{t('appName')}</span>
          <span className="sidebar__tagline">{t('appTagline')}</span>
        </div>
      </div>

      <div className="sidebar__new">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            selectJob(null)
            setView('studio')
          }}
        >
          <Icon name="plus" size={18} />
          {t('newRecording')}
          <span className="mono" aria-hidden="true" style={{ opacity: 0.55, marginInlineStart: 'auto' }}>
            01
          </span>
        </button>
      </div>

      <div className="sidebar__search">
        <span className="icon">
          <Icon name="search" size={16} />
        </span>
        <input
          className="input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('searchHistory')}
          aria-label={t('searchHistory')}
        />
      </div>

      <div className="sidebar__list scroll">
        {jobs.length === 0 && (
          <div className="sidebar__empty">
            <p style={{ fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>{t('noJobs')}</p>
            <p>{t('noJobsHint')}</p>
          </div>
        )}
        {ordered.length === 0 && jobs.length > 0 && (
          <div className="sidebar__empty">{t('noJobs')}</div>
        )}
        {(Object.keys(groups) as Array<keyof typeof groups>).map((key) => {
          const items = groups[key]
          if (!items.length) return null
          const labelKey: MessageKey =
            key === 'today'
              ? 'today'
              : key === 'yesterday'
                ? 'yesterday'
                : key === 'thisWeek'
                  ? 'thisWeek'
                  : 'older'
          return (
            <div key={key}>
              <div className="sidebar__group">
                <span className="tech tech--muted">{t(labelKey)}</span>
              </div>
              {items.map((job) => {
                const index = indexOf.get(job.id) ?? 0
                const active = job.id === activeId && view === 'studio'
                return (
                  <div
                    key={job.id}
                    className={`history-item${active ? ' is-active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectJob(job.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        selectJob(job.id)
                      }
                    }}
                  >
                    <span className="history-item__index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="history-item__body">
                      <span className="history-item__title" title={job.title}>
                        {job.title}
                      </span>
                      <span className="history-item__meta">
                        <span className={`history-item__dot ${statusClass(job)}`} />
                        <span>{formatDuration(job.durationSec)}</span>
                        <span>·</span>
                        <span>{formatTime(job.createdAt, lang)}</span>
                        {job.speakers.length > 0 && (
                          <>
                            <span>·</span>
                            <span>{speakerLabel(job.speakers.length, lang)}</span>
                          </>
                        )}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger history-item__delete"
                      aria-label={`${t('deleteJob')} — ${job.title}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setDeleteTarget(job)
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      <div className="sidebar__foot">
        <div className="engine-chip">
          <span className={`status-dot ${ready ? 'status-dot--ok' : 'status-dot--warn'}`} />
          <div className="engine-chip__text">
            <span className="engine-chip__title">
              {ready ? t('engine') + ' · ' + t('ready') : t('notReady')}
            </span>
            <span className="engine-chip__sub">{modelLabel}</span>
          </div>
        </div>
        <button
          type="button"
          className={`sidebar__settings${view === 'settings' ? ' is-active' : ''}`}
          onClick={() => setView('settings')}
        >
          <Icon name="settings" size={18} />
          {t('settings')}
          <span className="mono muted" style={{ marginInlineStart: 'auto', fontSize: 10 }}>
            {t('setup')}
          </span>
        </button>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('deleteJob')}
        message={t('deleteJobConfirm')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void removeJob(deleteTarget.id)
          setDeleteTarget(null)
        }}
      />
    </aside>
  )
}
