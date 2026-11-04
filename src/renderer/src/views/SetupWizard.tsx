import { useEffect, useMemo, useState } from 'react'
import type { ProviderId, SetupPhase } from '@shared/types'
import { useApp, useT } from '../store'
import { BrandMark, Icon } from '../components/Icon'
import { formatBytes } from '../lib/format'
import { providerLabel } from '../lib/providers'
import { SUMMARY_MODELS, recommendSummaryModel } from '@shared/summaryModels'
import { overallSetupPct } from '@shared/setupProgress'

const ENGINE_PHASES: SetupPhase[] = ['check', 'uv', 'python', 'deps', 'probe']
const MODEL_PHASES: SetupPhase[] = ['jais', 'diarizer']

const PHASE_LABEL: Record<SetupPhase, 'phaseCheck' | 'phaseUv' | 'phasePython' | 'phaseDeps' | 'phaseProbe' | 'phaseJais' | 'phaseDiarizer' | 'phaseDone'> = {
  check: 'phaseCheck',
  uv: 'phaseUv',
  python: 'phasePython',
  deps: 'phaseDeps',
  probe: 'phaseProbe',
  jais: 'phaseJais',
  diarizer: 'phaseDiarizer',
  done: 'phaseDone'
}

export function SetupWizard(): React.JSX.Element {
  const setup = useApp((state) => state.setup)
  const progress = useApp((state) => state.setupProgress)
  const setupRunning = useApp((state) => state.setupRunning)
  const logs = useApp((state) => state.setupLogs)
  const error = useApp((state) => state.setupError)
  const startSetup = useApp((state) => state.startSetup)
  const useExistingModel = useApp((state) => state.useExistingModel)
  const finishSetup = useApp((state) => state.finishSetup)
  const finishPending = useApp((state) => state.setupFinishPending)
  const providers = useApp((state) => state.providers)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const cancelSetup = useApp((state) => state.cancelSetup)
  const updateSettings = useApp((state) => state.updateSettings)
  const settings = useApp((state) => state.settings)
  const info = useApp((state) => state.info)
  const toast = useApp((state) => state.toast)
  const t = useT()
  const language = settings?.language ?? 'ar'

  const gpu = setup?.gpu
  const cpuOnly = Boolean(gpu) && !gpu?.available
  const gpuOk = !cpuOnly
  const vulkanWithoutVram = gpu?.acceleration === 'vulkan' && !gpu?.vramMb
  const diskOk = (setup?.disk.freeGb ?? 0) >= (setup?.disk.requiredGb ?? 5)
  const running = Boolean(setup?.running || setupRunning)
  const completed = Boolean(setup?.completed)

  const recommended = recommendSummaryModel(setup?.gpu.vramMb)
  const [mode, setMode] = useState<'local' | 'cloud' | 'none'>('local')
  const [localModel, setLocalModel] = useState(recommended)
  const [cloudProviderId, setCloudProviderId] = useState<ProviderId>('openai')
  const [cloudModel, setCloudModel] = useState('')
  const [cloudKey, setCloudKey] = useState('')
  const cloudProviders = providers.filter((provider) => provider.kind === 'cloud')
  const cloudInfo = providers.find((provider) => provider.id === cloudProviderId)
  const cloudKeySet = Boolean(settings?.providers[cloudProviderId]?.apiKeySet)

  useEffect(() => {
    setCloudModel(cloudInfo?.models[0] ?? '')
  }, [cloudInfo])

  useEffect(() => {
    // Warm the list on mount: the finish step needs it immediately, and asking
    // only once `finishPending` flips showed an empty datalist for ~1.5 s.
    let alive = true
    window.tafreegh.providers
      .models({ provider: 'ollama' })
      .then((names) => {
        if (alive) setOllamaModels(names)
      })
      .catch(() => {
        // Ollama not running: users can still type any tag manually.
      })
    return () => {
      alive = false
    }
  }, [finishPending])

  const saveSummaryChoice = (): void => {
    if (mode === 'local') {
      void finishSetup({ provider: 'ollama', model: localModel })
    } else if (mode === 'cloud') {
      void finishSetup({
        provider: cloudProviderId,
        model: cloudModel.trim() || cloudInfo?.models[0] || '',
        apiKey: cloudKey.trim() || undefined
      })
    } else {
      void finishSetup({ provider: 'none', model: '' })
    }
  }

  const stepIndex = useMemo(() => {
    if (completed) return 4
    if (running) {
      const phase = progress?.phase
      if (!phase || phase === 'check') return 1
      if (ENGINE_PHASES.includes(phase)) return 2
      if (MODEL_PHASES.includes(phase)) return 3
      if (phase === 'done') return 4
      return 2
    }
    return 1
  }, [completed, running, progress?.phase])

  const phase = progress?.phase ?? 'check'
  const pct = progress ? overallSetupPct(progress.phase, progress.pct) : 0
  const indeterminate = progress?.indeterminate ?? running
  const message = progress?.message || t('setupRunning')
  const detail = progress?.detail
  const errorMessage = error

  const copyError = async (): Promise<void> => {
    const text = errorMessage ?? message
    try {
      await window.tafreegh.app.copyText(text)
      toast(t('toastCopied'), 'success')
    } catch {
      // Fallback for contexts without the IPC bridge (plain browser preview).
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.top = '-1000px'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      toast(t(ok ? 'toastCopied' : 'copyFailed'), ok ? 'success' : 'error')
    }
  }

  return (
    <div className="setup">
      <aside className="setup__rail">
        <div className="setup__brand">
          <BrandMark size={30} />
          <div>
            <div className="setup__brand-word">{t('appName')}</div>
            <div className="tech tech--muted">{t('setupCounter')}</div>
          </div>
        </div>

        <ol className="setup__steps">
          {[
            { key: 'step1' as const, at: 1 },
            { key: 'step2' as const, at: 2 },
            { key: 'step3' as const, at: 3 },
            { key: 'step4' as const, at: 4 }
          ].map((step) => (
            <li
              key={step.key}
              className={`setup-step${stepIndex > step.at ? ' is-done' : ''}${stepIndex === step.at ? ' is-current' : ''}`}
            >
              <span className="setup-step__num">{String(step.at).padStart(2, '0')}</span>
              <span className="setup-step__label">{t(step.key)}</span>
            </li>
          ))}
        </ol>

        <div className="setup__rail-foot">
          <div className="lang-select" role="group" aria-label={t('language')}>
            <button
              type="button"
              className={settings?.language !== 'en' ? 'is-active' : ''}
              onClick={() => void updateSettings({ language: 'ar' })}
            >
              {t('arabic')}
            </button>
            <button
              type="button"
              className={settings?.language === 'en' ? 'is-active' : ''}
              onClick={() => void updateSettings({ language: 'en' })}
            >
              {t('english')}
            </button>
          </div>
          <span className="tech tech--muted">{t('localOnly')}</span>
          <span className="tech tech--muted">{t('version')} {info?.version ?? '—'}</span>
        </div>
      </aside>

      <main className="setup__main scroll">
        <div className="setup__inner">
          <p className="tech tech--accent">{t('setupKicker')}</p>
          <h1 className="setup__title">{t('setupTitle')}</h1>
          <p className="setup__lede">{t('setupLede')}</p>

          {!running && !completed && !errorMessage && (
            <>
              <div className="setup-check">
                <div className="setup-check__row">
                  <span className={`setup-check__icon ${gpuOk ? 'is-ok' : 'is-bad'}`}>
                    <Icon name={gpuOk ? 'check' : 'alert'} size={19} />
                  </span>
                  <div>
                    <p className="setup-check__title">{t('gpuCheck')}</p>
                    <p className="setup-check__sub">
                      {cpuOnly
                        ? t('cpuOnlyHint')
                        : `${t('gpuOk')} — ${gpu?.name ?? ''}${
                            gpu?.vramMb ? ` · ${Math.round(gpu.vramMb / 1024)} GB` : ` · ${t('vramUnknown')}`
                          }`}
                    </p>
                    {!cpuOnly && vulkanWithoutVram && (
                      <p className="setup-check__sub">{t('partialOffloadHint')}</p>
                    )}
                  </div>
                  <span className={`badge ${cpuOnly ? 'badge--accent' : ''}`}>
                    {cpuOnly ? t('cpuOnlyBadge') : t('ready')}
                  </span>
                </div>
                <div className="setup-check__row">
                  <span className={`setup-check__icon ${diskOk ? 'is-ok' : 'is-bad'}`}>
                    <Icon name={diskOk ? 'check' : 'alert'} size={19} />
                  </span>
                  <div>
                    <p className="setup-check__title">{t('diskCheck')}</p>
                    <p className="setup-check__sub">
                      {setup?.disk.freeGb !== undefined
                        ? <bdi dir="ltr">{`${formatBytes(setup.disk.freeGb * 1e9)} / ${setup.disk.requiredGb} GB`}</bdi>
                        : t('diskNeeded')}
                    </p>
                  </div>
                  <span className={`badge ${diskOk ? '' : 'badge--accent'}`}>
                    {diskOk ? t('diskOk') : t('diskLow')}
                  </span>
                </div>
                <div className="setup-check__row">
                  <span className="setup-check__icon is-ok">
                    <Icon name="shield" size={19} />
                  </span>
                  <div>
                    <p className="setup-check__title">{t('privacyTitle')}</p>
                    <p className="setup-check__sub">{t('privacyBody')}</p>
                  </div>
                  <span className="badge">{t('localBadge')}</span>
                </div>
              </div>

              {cpuOnly && (
                <p className="setup-warning">
                  <Icon name="alert" size={15} />
                  <span>{t('cpuOnlyWarning')}</span>
                </p>
              )}

              <ul className="setup-req">
                <li>{t('reqGpu')}</li>
                <li>{t('reqDisk')}</li>
                <li>{t('reqNet')}</li>
                <li>{t('reqPrivacy')}</li>
              </ul>

              <div className="setup__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!diskOk}
                  onClick={() => void startSetup()}
                >
                  <Icon name="download" size={17} />
                  {t('startSetup')}
                </button>
                <span className="tech tech--muted" style={{ alignSelf: 'center' }}>
                  {t('orLabel')}
                </span>
                <button type="button" className="btn btn--ghost" onClick={() => void useExistingModel()}>
                  <Icon name="folder" size={16} />
                  {t('haveModel')}
                </button>
              </div>
              <p className="setup-existing-hint">{t('haveModelHint')}</p>
              <p className="tech tech--muted" style={{ marginTop: 6 }}>
                {t('setupNote')}
              </p>
            </>
          )}

          {running && !errorMessage && (
            <section className="setup-progress" aria-label={t('setupRunning')}>
              <div className="setup-progress__head">
                <span className="spinner" />
                <span className="tech tech--accent">{t('setupRunning')}</span>
                <span style={{ flex: 1 }} />
                <span className="tech tech--muted">
                  {Math.round(pct)}%{' '}
                  {progress?.bytesTotal
                    ? `· ${formatBytes(Math.min(progress.bytesDone ?? 0, progress.bytesTotal))} / ${formatBytes(progress.bytesTotal)}`
                    : ''}
                </span>
              </div>
              <div className="setup-progress__body">
                <div className="workorder__stage">
                  <div>
                    <p className="tech tech--muted" style={{ marginBottom: 6 }}>
                      {t('phaseLabel')} {String(stepIndex).padStart(2, '0')} / 04
                    </p>
                    <h2 style={{ fontSize: 28, fontWeight: 900 }}>{t(PHASE_LABEL[phase])}</h2>
                  </div>
                  <div className="big-pct" style={{ fontSize: 62 }}>
                    {Math.round(pct)}
                    <span>%</span>
                  </div>
                </div>

                <div className={`progressbar${indeterminate ? ' is-indeterminate' : ''}`}>
                  <span className="progressbar__fill" style={{ ['--p' as string]: `${pct}%` }} />
                </div>

                <p className="progress-message" aria-live="polite">
                  {message}
                </p>
                {detail && <p className="progress-detail mono">{detail}</p>}

                <div style={{ marginTop: 14 }}>
                  {[...ENGINE_PHASES, ...MODEL_PHASES].map((item, index) => {
                    const itemIndex = index
                    const current = item === phase
                    const done =
                      !current &&
                      (stepIndex > (MODEL_PHASES.includes(item) ? 3 : 2) ||
                        (stepIndex === (MODEL_PHASES.includes(item) ? 3 : 2) &&
                          [...ENGINE_PHASES, ...MODEL_PHASES].indexOf(phase) > itemIndex))
                    return (
                      <div
                        key={item}
                        className={`setup-phase-row${done ? ' is-done' : ''}${current ? ' is-current' : ''}`}
                      >
                        <span className="setup-phase-row__pct">{String(index + 1).padStart(2, '0')}</span>
                        <span>{t(PHASE_LABEL[item])}</span>
                        <span className="setup-phase-row__pct">
                          {done ? '✓' : current ? (indeterminate ? '···' : `${Math.round(pct)}%`) : '—'}
                        </span>
                      </div>
                    )
                  })}
                </div>

                {logs.length > 0 && (
                  <div className="setup-log scroll" aria-label={t('logTail')}>
                    {logs.join('\n')}
                  </div>
                )}

                <div className="setup__actions">
                  <button type="button" className="btn btn--ghost" onClick={() => void cancelSetup()}>
                    <Icon name="pause" size={15} />
                    {t('cancelSetup')}
                  </button>
                  <span className="tech tech--muted" style={{ alignSelf: 'center' }}>
                    {t('setupNote')}
                  </span>
                </div>
              </div>
            </section>
          )}

          {errorMessage && (
            <div className="setup-error">
              <h3>{t('setupFailed')}</h3>
              <p dir="auto">{errorMessage}</p>
              <div className="alert-row">
                <button type="button" className="btn btn--primary" onClick={() => void startSetup()}>
                  <Icon name="refresh" size={16} />
                  {t('setupRetry')}
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => void copyError()}>
                  <Icon name="copy" size={15} />
                  {t('copy')}
                </button>
              </div>
            </div>
          )}

          {completed && !running && (
            <div className="setup-ready">
              <div className="setup-ready__stamp">
                {t('ready')}
                <br />
                04/04
              </div>
              <div>
                <h2 style={{ fontSize: 28, fontWeight: 900, marginBottom: 6 }}>{t('setupDone')}</h2>
                <p className="body-copy" style={{ fontSize: 14 }}>{t('setupDoneHint')}</p>
              </div>
            </div>
          )}

          {completed && !running && finishPending && (
            <section className="setup-summary">
              <p className="tech tech--accent">{t('finishKicker')}</p>
              <h2 className="setup-summary__title">{t('setupSummaryTitle')}</h2>
              <p className="setup-summary__lede">{t('setupSummaryLede')}</p>

              <div className="summary-modes" role="tablist" aria-label={t('setupSummaryTitle')}>
                {[
                  { id: 'local' as const, label: t('setupSummaryLocal') },
                  { id: 'cloud' as const, label: t('setupSummaryCloud') },
                  { id: 'none' as const, label: t('setupSummaryNone') }
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={mode === item.id}
                    className={`summary-mode${mode === item.id ? ' is-active' : ''}`}
                    onClick={() => setMode(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {mode === 'local' && (
                <>
                  <div className="summary-models" role="radiogroup" aria-label={t('setupSummaryLocal')}>
                    {SUMMARY_MODELS.map((model) => {
                      const active = localModel === model.id
                      const isRecommended = recommended === model.id
                      return (
                        <button
                          key={model.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          className={`summary-model${active ? ' is-active' : ''}`}
                          onClick={() => setLocalModel(model.id)}
                        >
                          <span className="summary-model__top">
                            <span className="mono">{model.id}</span>
                            {isRecommended && (
                              <span className="badge">{t('summaryRecommendedForGpu')}</span>
                            )}
                          </span>
                          <span className="summary-model__desc">
                            {language === 'ar' ? model.ar : model.en}
                          </span>
                          <span className="summary-model__size">
                            {t('summaryDownloadSize')}{' '}
                            <bdi dir="ltr">{`≈ ${model.sizeGb} GB`}</bdi>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <label className="field setup-summary__custom">
                    <span className="label-ar">{t('ollamaAnyModel')}</span>
                    <input
                      className="input mono"
                      list="wizard-ollama-models"
                      value={
                        SUMMARY_MODELS.some((model) => model.id === localModel) ? '' : localModel
                      }
                      placeholder={ollamaModels[0] ?? 'llama3.3:latest'}
                      onChange={(event) => setLocalModel(event.target.value)}
                    />
                    <datalist id="wizard-ollama-models">
                      {ollamaModels.map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                  </label>
                  <p className="setup-summary__note">{t('summaryLocalNote')}</p>
                </>
              )}

              {mode === 'cloud' && (
                <div className="summary-cloud">
                  <label className="field">
                    <span className="label-ar">{t('summaryCloudProvider')}</span>
                    <select
                      className="select"
                      value={cloudProviderId}
                      onChange={(event) => setCloudProviderId(event.target.value as ProviderId)}
                    >
                      {cloudProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {providerLabel(provider, language)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span className="label-ar">{t('summaryModelLabel')}</span>
                    <input
                      className="input mono"
                      list="setup-cloud-models"
                      value={cloudModel}
                      placeholder={t('summaryModelPlaceholder')}
                      onChange={(event) => setCloudModel(event.target.value)}
                    />
                    <datalist id="setup-cloud-models">
                      {(cloudInfo?.models ?? []).map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                  </label>
                  {!cloudKeySet && (
                    <label className="field summary-cloud__key">
                      <span className="label-ar">{t('summaryApiKey')}</span>
                      <input
                        className="input mono"
                        type="password"
                        autoComplete="off"
                        value={cloudKey}
                        placeholder={t('summaryApiKeyHint')}
                        onChange={(event) => setCloudKey(event.target.value)}
                      />
                    </label>
                  )}
                  <p className="setup-summary__note">{t('summaryCloudNote')}</p>
                </div>
              )}

              <div className="setup__actions">
                <button type="button" className="btn btn--primary" onClick={saveSummaryChoice}>
                  <Icon name="check" size={17} />
                  {t('setupStartUsing')}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void finishSetup({ provider: 'none', model: '' })}
                >
                  {t('setupLater')}
                </button>
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}
