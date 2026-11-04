import { useEffect, useRef, useState } from 'react'
import type { JobSummary } from '@shared/types'
import { DIALECTS } from '@shared/languages'
import { useApp, useLanguage, useT } from '../store'
import { Icon } from '../components/Icon'
import { formatBytes, formatDate, formatDuration, formatTime, speakerName } from '../lib/format'
import { providerLabel as providerLabelOf } from '../lib/providers'

export function ResultView({ job }: { job: JobSummary }): React.JSX.Element {
  const t = useT()
  const lang = useLanguage()
  const providers = useApp((state) => state.providers)
  const setView = useApp((state) => state.setView)
  const retrySummary = useApp((state) => state.retrySummary)
  const toast = useApp((state) => state.toast)
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    setLoading(true)
  }, [job.id, job.updatedAt])

  /**
   * The transcript page owns the speaker strip (it ships as a standalone file
   * too), so a rename arrives as a message from the iframe. Only the frame we
   * rendered is trusted; anything else on the window is ignored.
   */
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const data = event.data as { source?: string; type?: string; names?: unknown } | null
      if (!data || data.source !== 'tafreegh' || data.type !== 'speaker-names') return
      if (!data.names || typeof data.names !== 'object') return
      void window.tafreegh.jobs
        .renameSpeakers(job.id, data.names as Record<string, string>)
        .catch((error) => {
          toast(error instanceof Error ? error.message : String(error), 'error')
        })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [job.id, toast])

  const src = `tafreegh://job/${encodeURIComponent(job.id)}/transcript.html?v=${encodeURIComponent(job.updatedAt)}`
  const dialect = DIALECTS.find((item) => item.code === job.language)
  const dialectLabel = dialect ? (lang === 'ar' ? dialect.ar : dialect.en) : job.language
  const provider = providers.find((item) => item.id === job.summaryProvider)
  const providerLabel = provider
    ? providerLabelOf(provider, lang)
    : job.summaryProvider

  const reveal = async (): Promise<void> => {
    try {
      await window.tafreegh.jobs.reveal(job.id)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const retry = async (): Promise<void> => {
    setRetrying(true)
    try {
      await retrySummary(job.id)
    } finally {
      setRetrying(false)
    }
  }

  if (!job.files.html) {
    return (
      <div className="center-stage">
        <div className="empty-card">
          <h2>{t('jobError')}</h2>
          <p>{job.error || t('summaryMissingHint')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="result">
      <section className="result__titleblock" aria-label={t('resultKicker')}>
        <div className="result__tb-top">
          <span className="tech tech--accent">{t('resultKicker')}</span>
          <span className="result__tb-title" title={job.title}>
            {job.title}
          </span>
          <span style={{ flex: 1 }} />
          <span className={`badge ${job.status === 'done' ? 'badge--ink' : 'badge--accent'}`}>
            <span className="status-dot status-dot--ok" />
            {job.status === 'done' ? t('stageDone') : t('jobError')}
          </span>
        </div>
        <dl className="result__cells">
          <div className="tb-cell">
            <dt>{t('projectLabel')}</dt>
            <dd>{t('appName')}</dd>
          </div>
          <div className="tb-cell">
            <dt>{t('dateLabel')}</dt>
            <dd className="mono">{formatDate(job.createdAt, lang)}</dd>
          </div>
          <div className="tb-cell">
            <dt>{t('speechLabel')}</dt>
            <dd className="mono">
              {formatDuration(job.speechStart)}–{formatDuration(job.speechEnd)}
            </dd>
          </div>
          <div className="tb-cell">
            <dt>{t('speakersLabel')}</dt>
            <dd>{job.speakers.length ? job.speakers.map((speaker) => speakerName(speaker, lang)).join(' · ') : '—'}</dd>
          </div>
          <div className="tb-cell">
            <dt>{t('windowsLabel')}</dt>
            <dd className="mono">{job.windows ?? 0}</dd>
          </div>
          <div className="tb-cell">
            <dt>{t('sizeLabel')}</dt>
            <dd className="mono">{formatBytes(job.sizeBytes)}</dd>
          </div>
        </dl>
      </section>

      <div className="result__toolbar">
        <span className="tech tech--muted" style={{ marginInlineEnd: 8 }}>
          {formatTime(job.createdAt, lang)} · {dialectLabel}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void reveal()}>
          <Icon name="folder" size={15} />
          {t('reveal')}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void window.tafreegh.jobs.openOutput(job.id)}
        >
          <Icon name="external" size={15} />
          {t('openInBrowser')}
        </button>
      </div>

      <div className="result__frame-wrap">
        {(!job.hasSummary || job.summaryError) && (
          <div className="notice">
            <span className="dropzone__file-icon" style={{ width: 36, height: 36 }}>
              <Icon name="alert" size={17} />
            </span>
            <div className="notice__body">
              <p className="notice__title">
                {job.summaryError ? t('summaryMissing') : t('summaryMissing')}
              </p>
              <p className="notice__text">{job.summaryError || t('summaryMissingHint')}</p>
            </div>
            <div className="alert-row" style={{ flex: 'none' }}>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  setView('settings')
                }}
              >
                {t('configureSummary')}
              </button>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={retrying}
                onClick={() => void retry()}
              >
                {retrying ? t('testing') : t('retrySummary')}
              </button>
            </div>
          </div>
        )}

        <div className="result__frame">
          {loading && (
            <div className="frame-loading">
              <span className="spinner" />
              <span className="tech tech--muted">{t('loading')}</span>
            </div>
          )}
          <iframe
            key={`${job.id}-${job.updatedAt}`}
            ref={frameRef}
            title={job.title}
            src={src}
            sandbox="allow-scripts allow-same-origin allow-downloads"
            onLoad={() => setLoading(false)}
          />
        </div>
      </div>

      <div className="result__foot">
        <span className="tech tech--muted">
          JAIS-ASR GGUF · NEMOTRON-3
          {providerLabel ? ` · ${providerLabel}` : ''}
        </span>
        {job.summaryModel && (
          <span className="tech tech--muted">
            {t('summaryBy')} <span style={{ color: 'var(--body)' }}>{job.summaryModel}</span>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span className="tech tech--muted">{t('identifier')} {job.id.slice(-8).toUpperCase()}</span>
      </div>
    </div>
  )
}
