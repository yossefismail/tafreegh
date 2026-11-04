import { useEffect, useState } from 'react'
import type { AppFileInfo, ProviderId } from '@shared/types'
import { isAudioPath, DIALECTS } from '@shared/languages'
import { SUMMARY_MODELS, recommendSummaryModel } from '@shared/summaryModels'
import { useApp, useT } from '../store'
import { Icon } from '../components/Icon'
import { formatBytes, formatDuration, formatTime } from '../lib/format'
import { providerLabel } from '../lib/providers'

export function HomeView(): React.JSX.Element {
  const pendingFile = useApp((state) => state.pendingFile)
  const setPendingFile = useApp((state) => state.setPendingFile)
  const settings = useApp((state) => state.settings)
  const setup = useApp((state) => state.setup)
  const jobs = useApp((state) => state.jobs)
  const startJob = useApp((state) => state.startJob)
  const updateSettings = useApp((state) => state.updateSettings)
  const sessionSummary = useApp((state) => state.sessionSummarizer)
  const setSessionSummary = useApp((state) => state.setSessionSummarizer)
  const providers = useApp((state) => state.providers)
  const selectJob = useApp((state) => state.selectJob)
  const toast = useApp((state) => state.toast)
  const t = useT()
  const [fileInfo, setFileInfo] = useState<AppFileInfo | null>(null)
  const [dragging, setDragging] = useState(false)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    if (!pendingFile) {
      setFileInfo(null)
      return
    }
    void window.tafreegh.app.fileInfo(pendingFile).then((info) => {
      if (alive) setFileInfo(info)
    })
    return () => {
      alive = false
    }
  }, [pendingFile])

  const pick = async (): Promise<void> => {
    try {
      const path = await window.tafreegh.app.pickAudio()
      if (!path) return
      if (!isAudioPath(path)) {
        toast(t('unsupportedFile'), 'error')
        return
      }
      setPendingFile(path)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const language = settings?.language ?? 'ar'
  const ready = Boolean(setup?.completed)
  const recent = jobs.slice(0, 3)
  const canStart = Boolean(fileInfo && ready)

  const recommended = recommendSummaryModel(setup?.gpu.vramMb)
  const summaryChoice = sessionSummary ?? {
    provider: settings?.summarizer.provider ?? 'none',
    model: settings?.summarizer.model ?? ''
  }
  const summaryInfo = providers.find((provider) => provider.id === summaryChoice.provider)
  const summaryModels =
    summaryChoice.provider === 'ollama'
      ? [
          ...new Set([
            ...SUMMARY_MODELS.map((model) => model.id),
            ...(summaryInfo?.models ?? []),
            ...ollamaModels
          ])
        ]
      : summaryInfo?.models ?? []
  const summaryNeedsKey = Boolean(summaryInfo?.requiresKey) &&
    !settings?.providers[summaryChoice.provider as ProviderId]?.apiKeySet

  useEffect(() => {
    if (summaryChoice.provider !== 'ollama') return
    let alive = true
    window.tafreegh.providers
      .models({ provider: 'ollama' })
      .then((names) => {
        if (alive) setOllamaModels(names)
      })
      .catch(() => {
        // Ollama not running: the free-text field still accepts any tag.
      })
    return () => {
      alive = false
    }
  }, [summaryChoice.provider])

  return (
    <div className="home">
      <section className="home__hero">
        <div>
          <p className="tech tech--accent home__kicker rise">{t('homeKicker')}</p>
          <h1 className="home__headline rise" style={{ ['--d' as string]: 1 }}>
            {t('homeHeadline')}
          </h1>
          <p className="home__lede rise" style={{ ['--d' as string]: 2 }}>
            {t('homeLede')}
          </p>
        </div>
        <div className="home__aside rise" style={{ ['--d' as string]: 3 }}>
          <dl className="fact-list">
            <div className="fact-list__head">
              <span className="tech tech--muted">{t('systemStatus')} · 04</span>
              <span className={`status-dot ${ready ? 'status-dot--ok' : 'status-dot--warn'}`} />
            </div>
            <div className="fact-row">
              <dt>{t('engine')}</dt>
              <dd>{ready ? t('ready') : t('notReady')}</dd>
            </div>
            <div className="fact-row">
              <dt>{t('gpu')}</dt>
              <dd className="fact-row__wrap" title={setup?.gpu.name}>
                {setup?.gpu.name ?? (setup?.gpu.acceleration === 'cpu' ? t('cpuOnlyBadge') : '—')}
              </dd>
            </div>
            <div className="fact-row">
              <dt>{t('modelShort')}</dt>
              <dd className="mono">
                JAIS-ASR / {setup?.models?.jais?.variant === 'gguf-q8' ? 'Q8_0' : 'Q4_K_M'}
              </dd>
            </div>
            <div className="fact-row">
              <dt>{t('speechLabel')}</dt>
              <dd>{t('dialectsValue')}</dd>
            </div>
            <div className="fact-row">
              <dt>{t('privacyShort')}</dt>
              <dd className="fact-row__wrap">{t('localOnly')}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="home__grid">
        <div>
          <div
            className={`dropzone${dragging ? ' is-dragging' : ''}${fileInfo ? ' has-file' : ''}`}
            role={fileInfo ? undefined : 'button'}
            tabIndex={fileInfo ? undefined : 0}
            aria-label={fileInfo ? undefined : t('dropTitle')}
            onClick={fileInfo ? undefined : () => void pick()}
            onKeyDown={
              fileInfo
                ? undefined
                : (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      void pick()
                    }
                  }
            }
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={(event) => {
              event.preventDefault()
              if (event.currentTarget === event.target) setDragging(false)
            }}
            onDrop={() => setDragging(false)}
          >
            <span className="dropzone__corner dropzone__corner--tl" />
            <span className="dropzone__corner dropzone__corner--tr" />
            <span className="dropzone__corner dropzone__corner--bl" />
            <span className="dropzone__corner dropzone__corner--br" />
            {fileInfo ? (
              <>
                <div className="dropzone__file">
                  <span className="dropzone__file-icon">
                    <Icon name="waveform" size={24} />
                  </span>
                  <span className="dropzone__file-body">
                    <span className="dropzone__file-name" title={fileInfo.name}>
                      {fileInfo.name}
                    </span>
                    <span className="dropzone__file-meta">
                      {fileInfo.ext.toUpperCase()} · {formatBytes(fileInfo.size)}
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={(event) => {
                    event.stopPropagation()
                    void pick()
                  }}
                >
                  <Icon name="refresh" size={15} />
                  {t('changeFile')}
                </button>
              </>
            ) : (
              <>
                <span className="dropzone__icon">
                  <Icon name="waveform" size={44} strokeWidth={1.2} />
                </span>
                <span className="dropzone__title">{t('dropTitle')}</span>
                <span className="dropzone__hint">{t('dropHint')}</span>
                <span className="dropzone__browse btn btn--sm" aria-hidden="true">
                  <Icon name="plus" size={15} />
                  {t('chooseFile')}
                </span>
                <span className="tech dropzone__formats">{t('formats')}</span>
              </>
            )}
          </div>

          <div className="home__controls">
            <div className="transcribe-options">
            <label className="field">
              <span className="label-ar">{t('dialectLabel')}</span>
              <select
                className="select"
                value={settings?.dialect ?? 'EG'}
                onChange={(event) => void updateSettings({ dialect: event.target.value })}
              >
                {DIALECTS.map((dialect) => (
                  <option key={dialect.code} value={dialect.code}>
                    {language === 'ar' ? dialect.ar : dialect.en}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span className="label-ar">{t('enhanceLabel')}</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings?.enhance ?? true}
                  onChange={(event) => void updateSettings({ enhance: event.target.checked })}
                />
                <span className="switch__text muted" style={{ fontWeight: 500, fontSize: 12.5 }}>
                  {t('enhanceHint')}
                </span>
              </label>
            </div>
            <button
              type="button"
              className="btn btn--primary transcribe-options__go"
              disabled={!canStart}
              onClick={() => {
                if (pendingFile) void startJob(pendingFile)
              }}
            >
              <Icon name="waveform" size={18} />
              {t('startTranscribe')}
            </button>
          </div>

          <div className="session-summary">
            <span className="label-ar session-summary__label">{t('summaryAgent')}</span>
            <select
              className="select session-summary__provider"
              value={summaryChoice.provider}
              aria-label={t('summaryAgent')}
              onChange={(event) => {
                const provider = event.target.value as ProviderId | 'none'
                const info = providers.find((item) => item.id === provider)
                const model =
                  provider === 'none'
                    ? ''
                    : provider === 'ollama'
                      ? recommended
                      : info?.models[0] ?? ''
                setSessionSummary({ provider, model })
              }}
            >
              <option value="none">{t('setupSummaryNone')}</option>
              <optgroup label={t('setupSummaryLocal')}>
                {providers
                  .filter((provider) => provider.kind === 'local')
                  .map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {providerLabel(provider, language)}
                    </option>
                  ))}
              </optgroup>
              <optgroup label={t('setupSummaryCloud')}>
                {providers
                  .filter((provider) => provider.kind === 'cloud')
                  .map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {providerLabel(provider, language)}
                    </option>
                  ))}
              </optgroup>
            </select>
            {summaryChoice.provider !== 'none' && (
              <input
                className="input mono session-summary__model"
                list="session-summary-models"
                value={summaryChoice.model ?? ''}
                placeholder={
                  summaryChoice.provider === 'ollama'
                    ? t('ollamaAnyModel')
                    : t('summaryModelPlaceholder')
                }
                aria-label={t('summaryModelLabel')}
                onChange={(event) =>
                  setSessionSummary({ ...summaryChoice, model: event.target.value })
                }
              />
            )}
            {summaryChoice.provider === 'ollama' && summaryChoice.model !== recommended && (
              <button
                type="button"
                className="btn btn--ghost btn--sm session-summary__chip"
                onClick={() => setSessionSummary({ provider: 'ollama', model: recommended })}
              >
                {t('summaryRecommendedForGpu')}: <span className="mono">{recommended}</span>
              </button>
            )}
            <span className="tech tech--muted session-summary__hint">{t('summaryPerFile')}</span>
            <datalist id="session-summary-models">
              {summaryModels.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {summaryNeedsKey && <p className="session-summary__note">{t('summaryMissingKey')}</p>}
          </div>
          </div>

          {fileInfo && (
            <p className="tech tech--muted" style={{ marginTop: 10 }}>
              {fileInfo.path}
            </p>
          )}

          <div className="privacy-note">
            <span className="privacy-note__icon">
              <Icon name="shield" size={20} />
            </span>
            <div>
              <p className="privacy-note__title">{t('privacyTitle')}</p>
              <p className="privacy-note__text">{t('privacyBody')}</p>
            </div>
          </div>
        </div>

        <div>
          {recent.length > 0 ? (
            <section className="home__recent" style={{ paddingTop: 0 }}>
              <div className="settings-section__head">
                <h2 style={{ fontSize: 22 }}>{t('recent')}</h2>
                <span className="tech tech--muted">{String(jobs.length).padStart(2, '0')} {t('totalLabel')}</span>
              </div>
              <div className="recent-list">
                {recent.map((job, index) => (
                  <button
                    key={job.id}
                    type="button"
                    className="recent-card"
                    onClick={() => selectJob(job.id)}
                  >
                    <span className="recent-card__top">
                      <span className="tech">{String(index + 1).padStart(2, '0')}</span>
                      <span className={`status-dot ${job.status === 'done' ? 'status-dot--ok' : job.status === 'error' ? 'status-dot--warn' : 'status-dot--idle'}`} />
                    </span>
                    <span className="recent-card__title">{job.title}</span>
                    <span className="recent-card__meta">
                      {formatDuration(job.durationSec)} · {formatTime(job.createdAt, language)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <section className="how">
              <div className="how__head">
                <h2>{t('howTitle')}</h2>
                <span className="tech tech--muted">{t('howSteps')}</span>
              </div>
              <ol className="how__list">
                {[
                  { label: t('stageEnhance'), hint: t('howEnhanceHint') },
                  { label: t('stageDiarize'), hint: t('howDiarizeHint') },
                  { label: t('stageTranscribe'), hint: t('howTranscribeHint') },
                  { label: t('stageSummary'), hint: t('howSummaryHint') }
                ].map((step, index) => (
                  <li key={step.label} className="how__item">
                    <span className="how__num">{String(index + 1).padStart(2, '0')}</span>
                    <span>
                      <span className="how__title">{step.label}</span>
                      <span className="how__hint">{step.hint}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </section>
    </div>
  )
}
