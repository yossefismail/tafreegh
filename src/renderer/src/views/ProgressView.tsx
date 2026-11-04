import { useEffect, useMemo, useState } from 'react'
import type { JobSummary, StageId } from '@shared/types'
import { DIALECTS } from '@shared/languages'
import { useApp, useLanguage, useT } from '../store'
import { Icon } from '../components/Icon'
import { formatClock, formatDuration } from '../lib/format'

const STEPS: Array<{ stages: StageId[]; key: 'stageDecode' | 'stageEnhance' | 'stageDiarize' | 'stageTranscribe' | 'stageSummary' | 'stageRender' }> = [
  { stages: ['queued', 'copy', 'decode'], key: 'stageDecode' },
  { stages: ['enhance'], key: 'stageEnhance' },
  { stages: ['diarize'], key: 'stageDiarize' },
  { stages: ['load', 'transcribe'], key: 'stageTranscribe' },
  { stages: ['summary'], key: 'stageSummary' },
  { stages: ['audio', 'artifacts', 'render', 'done'], key: 'stageRender' }
]

function stageTitleKey(stage: StageId): (typeof STEPS)[number]['key'] | 'stageDone' {
  if (stage === 'done') return 'stageDone'
  if (stage === 'summary') return 'stageSummary'
  if (stage === 'render' || stage === 'audio' || stage === 'artifacts') return 'stageRender'
  if (stage === 'load' || stage === 'transcribe') return 'stageTranscribe'
  if (stage === 'diarize') return 'stageDiarize'
  if (stage === 'enhance') return 'stageEnhance'
  return 'stageDecode'
}

const EMPTY_LOGS: string[] = []

export function ProgressView({ job }: { job: JobSummary }): React.JSX.Element {
  const t = useT()
  const language = useLanguage()
  const startJob = useApp((state) => state.startJob)
  const cancelJob = useApp((state) => state.cancelJob)
  const selectJob = useApp((state) => state.selectJob)
  const logs = useApp((state) => state.logs[job.id]) ?? EMPTY_LOGS
  const [elapsed, setElapsed] = useState(0)

  const active = ['queued', 'running', 'summarizing', 'rendering'].includes(job.status)
  useEffect(() => {
    if (!active) return
    const started = new Date(job.createdAt).getTime()
    const tick = (): void => setElapsed(Date.now() - started)
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [active, job.createdAt])

  const currentIndex = useMemo(() => {
    if (job.status === 'done') return STEPS.length
    const found = STEPS.findIndex((step) => step.stages.includes(job.stage))
    return found === -1 ? 0 : found
  }, [job.stage, job.status])

  const overall = job.status === 'done' ? 100 : Math.round(job.progress?.overall ?? 0)
  const indeterminate = Boolean(job.progress?.indeterminate)
  const titleKey = stageTitleKey(job.stage)
  const message =
    job.status === 'queued'
      ? t('queued')
      : job.progress?.message || t(titleKey)
  const detail =
    job.progress?.detail ||
    (job.progress?.window && job.progress?.windows
      ? `${t('windowOf')} ${job.progress.window} / ${job.progress.windows}`
      : undefined)
  const failed = job.status === 'error' || job.status === 'cancelled'
  const dialect = DIALECTS.find((item) => item.code === job.language)
  const dialectLabel = dialect ? (language === 'ar' ? dialect.ar : dialect.en) : job.language

  return (
    <div className="jobview">
      <section className="workorder" aria-label={t('workOrder')}>
        <header className="workorder__head">
          <span className="workorder__num">
            {t('workOrderLabel')} · <bdi>{job.id.slice(-4).toUpperCase()}</bdi>
          </span>
          <span className="workorder__title" title={job.title}>
            {job.title}
          </span>
          <span className="workorder__spacer" />
          <span className={`badge ${failed ? 'badge--accent' : active ? 'badge--ink' : ''}`}>
            <span className={`status-dot ${failed ? 'status-dot--warn' : active ? '' : 'status-dot--ok'}`} />
            {job.status === 'cancelled'
              ? t('jobCancelled')
              : failed
                ? t('jobError')
                : active
                  ? t('processing')
                  : t('stageDone')}
          </span>
          {active && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void cancelJob(job.id)}
            >
              <Icon name="pause" size={14} />
              {t('cancelJob')}
            </button>
          )}
        </header>

        <div className="workorder__body">
          <ol className="steps">
            {STEPS.map((step, index) => {
              const done = job.status === 'done' || index < currentIndex
              const current = !failed && index === currentIndex && job.status !== 'done'
              return (
                <li
                  key={step.key}
                  className={`step${done ? ' is-done' : ''}${current ? ' is-current' : ''}`}
                >
                  <span className="step__num">{String(index + 1).padStart(2, '0')}</span>
                  <span className="step__label">{t(step.key)}</span>
                  <span className="step__state">
                    {done ? '✓' : current ? (indeterminate ? '···' : `${overall}%`) : '—'}
                  </span>
                </li>
              )
            })}
          </ol>

          <div className="workorder__main">
            <div className="workorder__stage">
              <div>
                <p className="tech tech--accent" style={{ marginBottom: 8 }}>
                  {failed ? t('statusHalted') : job.status === 'done' ? t('statusComplete') : t('statusRunningShort')}
                </p>
                <h2>{failed ? (job.status === 'cancelled' ? t('jobCancelled') : t('jobError')) : t(titleKey)}</h2>
              </div>
              <div className="big-pct" aria-label={`${overall}%`}>
                {overall}
                <span>%</span>
              </div>
            </div>

            <div
              className={`progressbar${indeterminate && !failed ? ' is-indeterminate' : ''}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={overall}
              aria-valuetext={`${overall}%`}
            >
              <span className="progressbar__fill" style={{ ['--p' as string]: `${overall}%` }} />
            </div>

            <div className="progress-meta">
              <span className="tech tech--muted" dir="auto">{job.title}</span>
              <span className="tech tech--muted">
                {t('elapsed')}{' '}
                <span
                  style={{ color: 'var(--ink)', direction: 'ltr', unicodeBidi: 'isolate' }}
                >
                  {formatClock(elapsed || (job.progress?.elapsedMs ?? 0))}
                </span>
              </span>
            </div>

            <p className="progress-message" aria-live="polite">
              {message}
            </p>
            {detail && <p className="progress-detail mono">{detail}</p>}

            {failed ? (
              <div className="job-alert">
                <h3>{job.status === 'cancelled' ? t('jobCancelled') : t('jobError')}</h3>
                <p>
                  {job.status === 'cancelled'
                    ? t('jobCancelledHint')
                    : job.error || t('workingHint')}
                </p>
                <div className="alert-row">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void startJob(job.sourcePath)}
                  >
                    <Icon name="refresh" size={16} />
                    {t('tryAgain')}
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => selectJob(null)}>
                    {t('back')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="progress-foot">
                <span className="tech tech--muted">{t('workingHint')}</span>
                <span style={{ flex: 1 }} />
                <span className="tech tech--muted">
                  <span style={{ direction: 'ltr', unicodeBidi: 'isolate' }}>
                    {formatDuration(job.durationSec)}
                  </span>{' '}
                  · {dialectLabel}
                </span>
              </div>
            )}

            <details className="tech-log">
              <summary>
                <span className="tech tech--muted">{t('technicalLog')}</span>
                <Icon name="chevron" size={16} />
              </summary>
              <div className="tech-log__body">
                {(logs.length ? logs : [job.error || job.progress?.message || '—']).join('\n')}
              </div>
            </details>
          </div>
        </div>
      </section>
    </div>
  )
}
