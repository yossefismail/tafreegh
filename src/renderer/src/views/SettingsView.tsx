import { useEffect, useMemo, useState } from 'react'
import type { GpuInfo, ModelKind, ProviderId, TestProviderResult } from '@shared/types'
import type { MessageKey } from '../i18n'
import { useApp, useT } from '../store'
import { Icon } from '../components/Icon'
import { ConfirmDialog } from '../components/Overlays'
import { formatBytes } from '../lib/format'
import { DIALECTS } from '@shared/languages'
import { recommendSummaryModel } from '@shared/summaryModels'

/**
 * The engine ships one llama.cpp build; naming it beats reporting a flag the
 * user cannot act on. `cuda` is only reachable with a CUDA build.
 */
function backendName(
  t: (key: MessageKey) => string,
  acceleration?: GpuInfo['acceleration']
): string {
  if (acceleration === 'vulkan') return 'Vulkan'
  if (acceleration === 'cuda') return 'CUDA'
  if (acceleration === 'cpu') return 'CPU'
  return t('available')
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return path
  return `…\\${parts.slice(-2).join('\\')}`
}

function ModelRow({
  label,
  sub,
  recommended,
  size,
  status,
  present,
  muted = false,
  path,
  custom = false,
  busy,
  actionLabel,
  onDownload,
  onChoose
}: {
  label: string
  sub: string
  /** Variant this device would install, when it differs from the installed one. */
  recommended?: string | null
  size: string
  status: string
  present: boolean
  muted?: boolean
  path?: string
  custom?: boolean
  busy: boolean
  /** Overrides the download button text (e.g. "switch to the recommended artifact"). */
  actionLabel?: string
  onDownload: () => void
  onChoose: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="model-card">
      <div className="model-row">
        <div>
          <div className="model-row__name">{label}</div>
          <div className="model-row__sub">{sub}</div>
          {recommended && (
            <div className="model-row__recommended" dir="rtl">
              {t('recommendedForDevice')}: <bdi dir="ltr">{recommended}</bdi>
            </div>
          )}
        </div>
        <span className="model-row__size">{size}</span>
        <span className={`badge ${present ? '' : 'badge--accent'}${muted ? ' badge--muted' : ''}`}>
          {status}
        </span>
      </div>
      <div className="model-row__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onDownload} disabled={busy}>
          <Icon name="download" size={14} />
          {busy
            ? t('downloading')
            : present
              ? (actionLabel ?? t('modelRedownload'))
              : t('modelDownload')}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onChoose} disabled={busy}>
          <Icon name="folder" size={14} />
          {t('modelChoosePath')}
        </button>
        {path && (
          <span className="model-row__path" title={path}>
            {custom ? `${t('modelCustomPath')} · ` : ''}
            {shortPath(path)}
          </span>
        )}
      </div>
    </div>
  )
}

export function SettingsView(): React.JSX.Element {  const settings = useApp((state) => state.settings)
  const setup = useApp((state) => state.setup)
  const providers = useApp((state) => state.providers)
  const info = useApp((state) => state.info)
  const updateSettings = useApp((state) => state.updateSettings)
  const setApiKey = useApp((state) => state.setApiKey)
  const clearApiKey = useApp((state) => state.clearApiKey)
  const refreshSetup = useApp((state) => state.refreshSetup)
  const downloadModel = useApp((state) => state.downloadModel)
  const pickModelPath = useApp((state) => state.pickModelPath)
  const setHfToken = useApp((state) => state.setHfToken)
  const clearHfToken = useApp((state) => state.clearHfToken)
  const modelProgress = useApp((state) => state.setupProgress)
  const toast = useApp((state) => state.toast)
  const t = useT()

  const selected = (settings?.summarizer.provider ?? 'none') as ProviderId | 'none'
  const selectedInfo = providers.find((provider) => provider.id === selected)
  const language = settings?.language ?? 'ar'

  const [apiKey, setApiKeyValue] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [temperature, setTemperature] = useState(0.2)
  const [maxTokens, setMaxTokens] = useState(2500)
  const [fetching, setFetching] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestProviderResult | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'remove' | 'jais-download' | null>(null)
  const [busyKind, setBusyKind] = useState<ModelKind | null>(null)
  const [hfTokenDraft, setHfTokenDraft] = useState('')
  const [savingToken, setSavingToken] = useState(false)
  const setupRunning = useApp((state) => state.setupRunning)
  const running = Boolean(setup?.running || setupRunning)
  // Only trust progress events that belong to the download the user started.
  const activeDownload = busyKind && modelProgress?.phase === busyKind ? modelProgress : null
  const downloadPct = Math.max(0, Math.min(100, activeDownload?.pct ?? 0))

  useEffect(() => {
    const current = useApp.getState().settings
    if (!current) return
    const found = useApp.getState().providers.find((p) => p.id === selected)
    const stored = selected === 'none' ? undefined : current.providers[selected as ProviderId]
    setBaseUrl(stored?.baseUrl || found?.defaultBaseUrl || '')
    setModel(
      current.summarizer.provider === selected
        ? current.summarizer.model
        : stored?.model || found?.models[0] || ''
    )
    setModels(found?.models ?? [])
    setApiKeyValue('')
    setTestResult(null)
    setModelError(null)
    setTemperature(current.summarizer.temperature)
    setMaxTokens(current.summarizer.maxTokens)
  }, [selected])

  const groups = useMemo(() => {
    const local = providers.filter((provider) => provider.kind === 'local')
    const cloud = providers.filter((provider) => provider.kind === 'cloud')
    return { local, cloud }
  }, [providers])

  const runDownload = async (kind: ModelKind): Promise<void> => {
    setBusyKind(kind)
    try {
      await downloadModel(kind)
    } finally {
      setBusyKind(null)
    }
  }

  const choose = (id: ProviderId | 'none'): void => {    if (!settings) return
    const found = providers.find((provider) => provider.id === id)
    const nextModel =
      id === 'none'
        ? ''
        : settings.providers[id]?.model || found?.models[0] || ''
    void updateSettings({
      summarizer: {
        ...settings.summarizer,
        provider: id,
        model: nextModel,
        baseUrl: id === 'none' ? '' : settings.providers[id]?.baseUrl || found?.defaultBaseUrl || ''
      },
      ...(id === 'none'
        ? {}
        : {
            providers: {
              ...settings.providers,
              [id]: {
                model: nextModel,
                baseUrl: settings.providers[id]?.baseUrl || found?.defaultBaseUrl || ''
              }
            }
          })
    })
  }

  const fetchModels = async (): Promise<void> => {
    if (!selectedInfo) return
    setFetching(true)
    setModelError(null)
    try {
      const list = await window.tafreegh.providers.models({
        provider: selectedInfo.id,
        baseUrl: baseUrl || undefined,
        apiKey: apiKey || undefined
      })
      setModels(list)
      if (list.length && !list.includes(model)) setModel(list[0])
      toast(`${list.length} ${language === 'ar' ? 'نموذجًا متاحًا' : 'models available'}`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setModelError(message)
      toast(message, 'error')
    } finally {
      setFetching(false)
    }
  }

  const test = async (): Promise<void> => {
    if (!selectedInfo) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.tafreegh.providers.test({
        provider: selectedInfo.id,
        baseUrl: baseUrl || undefined,
        apiKey: apiKey || undefined,
        model: model || undefined
      })
      setTestResult(result)
    } catch (error) {
      setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setTesting(false)
    }
  }

  const saveConfig = async (): Promise<void> => {
    if (!settings || !selectedInfo) return
    if (!model.trim()) {
      toast(t('modelRequired'), 'error')
      return
    }
    await updateSettings({
      summarizer: {
        ...settings.summarizer,
        provider: selectedInfo.id,
        model: model.trim(),
        baseUrl: baseUrl.trim(),
        temperature,
        maxTokens
      },
      providers: {
        ...settings.providers,
        [selectedInfo.id]: { model: model.trim(), baseUrl: baseUrl.trim() }
      }
    })
    toast(t('settingsSaved'), 'success')
  }

  if (!settings || !setup) {
    return (
      <div className="center-stage">
        <div className="empty-card">
          <h2>{t('loading')}</h2>
        </div>
      </div>
    )
  }

  const jais = setup.models.jais
  const diarizer = setup.models.diarizer
  // What this device would install today, when it is not what is on disk.
  const variantNames: Record<string, string> = {
    gguf: 'Q4_K_M GGUF',
    'gguf-q8': 'Q8_0 GGUF'
  }
  const recommended =
    jais.suggested && jais.suggested !== jais.variant
      ? (variantNames[jais.suggested] ?? jais.suggested)
      : null
  const keySet = selected !== 'none' ? Boolean(settings.providers[selected as ProviderId]?.apiKeySet) : false

  return (
    <div className="settings">
      <header className="settings__hero">
        <div>
          <p className="tech tech--accent">{t('settingsKicker')}</p>
          <h1 className="settings__title">{t('settingsTitle')}</h1>
          <p className="settings__lede">{t('settingsLede')}</p>
        </div>
        <div className="settings__date">
          <div className="tech tech--muted">{t('version')}</div>
          <div className="mono" style={{ fontWeight: 700 }}>{info?.version ?? '—'}</div>
          <div className="tech tech--muted" style={{ marginTop: 8 }}>
            {info?.mock ? t('engineMock') : t('engineLocal')}
          </div>
        </div>
      </header>

      <section className="settings-section">
        <div className="settings-section__index">01</div>
        <div>
          <div className="settings-section__head">
            <h2>{t('engineSection')}</h2>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refreshSetup()}>
              <Icon name="refresh" size={14} />
              {t('resetSetup')}
            </button>
          </div>
          <p className="settings-section__hint">{t('engineSectionHint')}</p>

          <div className="status-grid">
            <div className="status-row">
              <span className="status-row__label">PYTHON</span>
              <span className="status-row__value mono">{setup.runtime.pythonVersion ?? '—'}</span>
            </div>
            <div className="status-row">
              {/* The engine ships a Vulkan build, so "CUDA: unavailable" read as
                  "no GPU" next to a detected GPU. Name the backend in use. */}
              <span className="status-row__label">{t('gpuBackend')}</span>
              <span className="status-row__value">
                <span
                  className={`status-dot ${setup.gpu?.available ? 'status-dot--ok' : 'status-dot--warn'}`}
                />{' '}
                {setup.gpu?.available ? backendName(t, setup.gpu.acceleration) : t('unavailable')}
              </span>
            </div>
            <div className="status-row">
              <span className="status-row__label">{t('engineSource')}</span>
              <span className="status-row__value" title={setup.engine}>
                {setup.mode === 'existing' ? t('engineExisting') : t('engineManaged')}
              </span>
            </div>
            <div className="status-row">
              <span className="status-row__label">{t('gpu')}</span>
              <span className="status-row__value" title={setup.gpu.name}>
                {setup.gpu.name ?? (setup.gpu.acceleration === 'cpu' ? t('cpuOnlyBadge') : '—')}
              </span>
            </div>
          </div>

          <div className="model-list">
            <ModelRow
              label={t('jaisModel')}
              sub={`${jais.variantLabel ?? 'Jais-ASR'} · 5.7B · WER ${jais.wer ?? '—'}`}
              recommended={recommended}
              size={`${formatBytes(jais.bytes)} / ${formatBytes(jais.totalBytes)}`}
              status={jais.present ? t('present') : t('missing')}
              present={jais.present}
              path={jais.path}
              custom={jais.custom}
              busy={busyKind === 'jais' || running}
              actionLabel={jais.present && recommended ? t('switchArtifact') : undefined}
              onDownload={() => {
                if (jais.present && recommended) setConfirm('jais-download')
                else void runDownload('jais')
              }}
              onChoose={() => void pickModelPath('jais')}
            />
            <ModelRow
              label={t('diarizerModel')}
              sub="NEMOTRON-3-DIARIZATION · SORTFORMER V3 · Q8"
              size={formatBytes(diarizer.bytes)}
              status={diarizer.present ? t('present') : t('missing')}
              present={diarizer.present}
              path={diarizer.path}
              custom={diarizer.custom}
              busy={busyKind === 'diarizer' || running}
              onDownload={() => void runDownload('diarizer')}
              onChoose={() => void pickModelPath('diarizer')}
            />
          </div>

          {busyKind && (
            <div className="download-progress" aria-live="polite">
              <div className="download-progress__head">
                <span className="tech tech--accent">
                  {busyKind === 'jais' ? t('jaisModel') : t('diarizerModel')}
                </span>
                <span style={{ flex: 1 }} />
                <span className="tech tech--muted" dir="ltr">
                  {activeDownload?.bytesTotal
                    ? `${formatBytes(Math.min(activeDownload.bytesDone ?? 0, activeDownload.bytesTotal))} / ${formatBytes(activeDownload.bytesTotal)} · ${Math.round(downloadPct)}%`
                    : `${Math.round(downloadPct)}%`}
                </span>
              </div>
              <div
                className={`progressbar${activeDownload?.indeterminate ? ' is-indeterminate' : ''}`}
              >
                <span
                  className="progressbar__fill"
                  style={{ ['--p' as string]: `${downloadPct}%` }}
                />
              </div>
              <p className="settings-footnote" style={{ marginTop: 6 }}>
                {activeDownload?.message ?? t('downloading')}
              </p>
            </div>
          )}

          <div className="settings-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm btn--danger"
              onClick={() => setConfirm('remove')}
            >
              <Icon name="trash" size={14} />
              {t('removeModels')}
            </button>
          </div>

          <div style={{ marginTop: 18 }}>
            <span className="label-ar">{t('dataFolder')}</span>
            <div className="data-path">{setup.paths.dataRoot}</div>
            <div className="settings-actions" style={{ marginTop: 0 }}>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void window.tafreegh.app.revealPath(setup.paths.dataRoot)}
              >
                <Icon name="folder" size={14} />
                {t('reveal')}
              </button>
            </div>
            <p className="settings-footnote">{t('dataFolderHint')}</p>
          </div>

          <div className="hf-token" style={{ marginTop: 18 }}>
            <span className="label-ar">{t('hfTokenLabel')}</span>
            <div className="key-row">
              <input
                id="settings-hf-token"
                className="input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                value={hfTokenDraft}
                onChange={(event) => setHfTokenDraft(event.target.value)}
                placeholder={settings?.hfTokenSet ? '••••••••••••••••' : 'hf_…'}
              />
              <button
                type="button"
                className="btn"
                disabled={savingToken || hfTokenDraft.trim().length < 8}
                onClick={() => {
                  setSavingToken(true)
                  void setHfToken(hfTokenDraft.trim()).finally(() => {
                    setSavingToken(false)
                    // keep the text when the token was rejected
                    if (useApp.getState().settings?.hfTokenSet) setHfTokenDraft('')
                  })
                }}
              >
                {savingToken ? t('hfTokenChecking') : t('saveKey')}
              </button>
              {settings?.hfTokenSet && (
                <button
                  type="button"
                  className="btn btn--ghost btn--danger"
                  onClick={() => void clearHfToken()}
                >
                  {t('clearKey')}
                </button>
              )}
            </div>
            <div className="config-note">
              <span
                className={`status-dot ${settings?.hfTokenSet ? 'status-dot--ok' : 'status-dot--idle'}`}
              />
              {settings?.hfTokenSet ? t('hfTokenStored') : t('hfTokenMissing')}
              <span>·</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                style={{ minHeight: 28, padding: '0 6px' }}
                onClick={() => void window.tafreegh.app.openExternal('https://huggingface.co/settings/tokens')}
              >
                {t('hfTokenGet')}
                <Icon name="external" size={12} />
              </button>
            </div>
            <p className="settings-footnote">{t('hfTokenHint')}</p>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section__index">02</div>
        <div>
          <div className="settings-section__head">
            <h2>{t('summarizerSection')}</h2>
            <span className={`badge ${selected !== 'none' ? 'badge--ink' : ''}`}>
              {selected === 'none' ? t('noneProvider') : language === 'ar' ? selectedInfo?.nameAr : selectedInfo?.name}
            </span>
          </div>
          <p className="settings-section__hint">{t('summarizerHint')}</p>

          <div className="provider-groups">
            <div>
              <div className="provider-group__label">
                <span className="status-dot status-dot--ok" />
                <span className="tech">{t('localProviders')}</span>
                <span style={{ flex: 1 }} />
                <span className="tech tech--muted">{t('noKeyLocal')}</span>
              </div>
              <div className="provider-grid">
                <button
                  type="button"
                  className={`provider-card${selected === 'none' ? ' is-selected' : ''}`}
                  onClick={() => choose('none')}
                >
                  <span className="provider-card__kind">{t('offLabel')}</span>
                  <span className="provider-card__name">{t('noneProvider')}</span>
                  <span className="provider-card__note">{t('noneProviderHint')}</span>
                </button>
                {groups.local.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    className={`provider-card${selected === provider.id ? ' is-selected' : ''}`}
                    onClick={() => choose(provider.id)}
                  >
                    <span className="provider-card__kind">
                      {provider.id === 'custom' ? t('openaiCompat') : t('localHttp')}
                    </span>
                    <span className="provider-card__name">
                      {language === 'ar' ? provider.nameAr : provider.name}
                    </span>
                    <span className="provider-card__note">
                      {language === 'ar' ? provider.noteAr : provider.noteEn}
                    </span>
                    <span className="provider-card__key">
                      <span className="status-dot status-dot--ok" />
                      {provider.defaultBaseUrl.replace(/^https?:\/\//, '')}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="provider-group__label">
                <span className="status-dot status-dot--idle" />
                <span className="tech">{t('cloudProviders')}</span>
                <span style={{ flex: 1 }} />
                <span className="tech tech--muted">{t('transcriptOnly')}</span>
              </div>
              <div className="provider-grid">
                {groups.cloud.map((provider) => {
                  const stored = settings.providers[provider.id]
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      className={`provider-card${selected === provider.id ? ' is-selected' : ''}`}
                      onClick={() => choose(provider.id)}
                    >
                      <span className="provider-card__kind">{t('cloudApi')}</span>
                      <span className="provider-card__name">
                        {language === 'ar' ? provider.nameAr : provider.name}
                      </span>
                      <span className="provider-card__key">
                        <span className={`status-dot ${stored?.apiKeySet ? 'status-dot--ok' : 'status-dot--idle'}`} />
                        {stored?.apiKeySet ? t('apiKeyStored') : t('apiKeyMissing')}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {selected !== 'none' && selectedInfo && (
            <div className="config-panel">
              {selectedInfo.requiresKey && (
                <div className="field config-panel__wide">
                  <span className="label-ar">{t('apiKey')}</span>
                  <div className="key-row">
                    <input
                      className="input"
                      type="password"
                      autoComplete="off"
                      value={apiKey}
                      onChange={(event) => setApiKeyValue(event.target.value)}
                      placeholder={keySet ? '••••••••••••••••' : t('apiKeyPlaceholder')}
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void setApiKey(selectedInfo.id, apiKey)}
                    >
                      {t('saveKey')}
                    </button>
                    {keySet && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--danger"
                        onClick={() => void clearApiKey(selectedInfo.id)}
                      >
                        {t('clearKey')}
                      </button>
                    )}
                  </div>
                  <div className="config-note">
                    <span className={`status-dot ${keySet ? 'status-dot--ok' : 'status-dot--idle'}`} />
                    {keySet ? t('apiKeyStored') : t('apiKeyMissing')}
                    {selectedInfo.docsUrl && (
                      <>
                        <span>·</span>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          style={{ minHeight: 28, padding: '0 6px' }}
                          onClick={() => void window.tafreegh.app.openExternal(selectedInfo.docsUrl!)}
                        >
                          {t('getKey')}
                          <Icon name="external" size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}

              <label className="field config-panel__wide">
                <span className="label-ar">{t('baseUrl')}</span>
                <input
                  className="input mono"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={selectedInfo.defaultBaseUrl || 'http://127.0.0.1:8080/v1'}
                />
              </label>

              <label className="field">
                <span className="label-ar">{t('modelName')}</span>
                <input
                  className="input mono"
                  list={`models-${selectedInfo.id}`}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder={t('modelPlaceholder')}
                />
                <datalist id={`models-${selectedInfo.id}`}>
                  {models.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </label>

              {selectedInfo.id === 'ollama' && (
                <div className="config-note config-panel__wide">
                  <span className="status-dot status-dot--ok" />
                  {t('summaryRecommendedForGpu')}:{' '}
                  <span className="mono">{recommendSummaryModel(setup?.gpu.vramMb)}</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setModel(recommendSummaryModel(setup?.gpu.vramMb))}
                  >
                    {t('useRecommended')}
                  </button>
                </div>
              )}

              <div className="field">
                <span className="label-ar" style={{ visibility: 'hidden' }}>
                  .
                </span>
                <button
                  type="button"
                  className="btn"
                  disabled={fetching}
                  onClick={() => void fetchModels()}
                >
                  {fetching ? <span className="spinner" /> : <Icon name="refresh" size={15} />}
                  {fetching ? t('fetchingModels') : t('fetchModels')}
                </button>
              </div>

              <label className="field">
                <span className="label-ar">
                  {t('temperature')} · <span className="mono">{temperature.toFixed(1)}</span>
                </span>
                <input
                  className="slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={temperature}
                  onChange={(event) => setTemperature(Number(event.target.value))}
                />
              </label>

              <label className="field">
                <span className="label-ar">{t('maxTokens')}</span>
                <input
                  className="input mono"
                  type="number"
                  min={256}
                  max={16000}
                  step={100}
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(Number(event.target.value))}
                />
              </label>

              <div className="config-actions">
                <button type="button" className="btn btn--primary" onClick={() => void saveConfig()}>
                  <Icon name="check" size={16} />
                  {t('save')}
                </button>
                <button type="button" className="btn" disabled={testing} onClick={() => void test()}>
                  {testing ? <span className="spinner" /> : <Icon name="spark" size={15} />}
                  {testing ? t('testing') : t('testConnection')}
                </button>
                <span
                  className={`config-note${testResult ? (testResult.ok ? ' is-ok' : ' is-bad') : ''}`}
                  role="status"
                  aria-live="polite"
                >
                  {testResult && (
                    <>
                      <span className={`status-dot ${testResult.ok ? 'status-dot--ok' : 'status-dot--warn'}`} />
                      {testResult.ok
                        ? `${t('testOk')} · ${testResult.latencyMs ?? 0} MS`
                        : `${t('testFailed')} · ${testResult.error ?? ''}`}
                    </>
                  )}
                  {!testResult && modelError && (
                    <>
                      <span className="status-dot status-dot--warn" />
                      {modelError}
                    </>
                  )}
                </span>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section__index">03</div>
        <div>
          <h2 style={{ marginBottom: 6 }}>{t('transcriptionSection')}</h2>
          <p className="settings-section__hint">
            {language === 'ar'
              ? 'إعدادات افتراضية لكل تسجيل جديد. يمكنك تغيير اللهجة لكل ملف من الشاشة الرئيسية.'
              : 'Defaults for each new recording. You can change the dialect per file on the home screen.'}
          </p>
          <div className="settings-split">
            <label className="field">
              <span className="label-ar">{t('defaultDialect')}</span>
              <select
                className="select"
                value={settings.dialect}
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
              <span className="label-ar">{t('enhanceDefault')}</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.enhance}
                  onChange={(event) => void updateSettings({ enhance: event.target.checked })}
                />
                <span className="switch__text muted" style={{ fontWeight: 500, fontSize: 12.5 }}>
                  {t('enhanceHint')}
                </span>
              </label>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section__index">04</div>
        <div>
          <h2 style={{ marginBottom: 6 }}>{t('appearanceSection')}</h2>
          <p className="settings-section__hint">{t('appearanceHint')}</p>
          <div className="lang-select" role="group" aria-label={t('language')}>
            <button
              type="button"
              className={language === 'ar' ? 'is-active' : ''}
              onClick={() => void updateSettings({ language: 'ar' })}
            >
              {t('arabic')}
            </button>
            <button
              type="button"
              className={language === 'en' ? 'is-active' : ''}
              onClick={() => void updateSettings({ language: 'en' })}
            >
              {t('english')}
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section__index">05</div>
        <div>
          <h2 style={{ marginBottom: 6 }}>{t('securitySection')}</h2>
          <p className="settings-section__hint">{t('securityBody')}</p>
          <div className="status-grid">
            <div className="status-row">
              <span className="status-row__label">{t('version')}</span>
              <span className="status-row__value mono">{info?.version ?? '—'}</span>
            </div>
            <div className="status-row">
              <span className="status-row__label">{t('platformLabel')}</span>
              <span className="status-row__value mono">{info?.platform ?? '—'}</span>
            </div>
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={confirm === 'remove'}
        title={t('removeModels')}
        message={t('removeModelsConfirm')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null)
          void (async () => {
            await window.tafreegh.setup.removeModels()
            await refreshSetup()
            toast(t('saved'), 'success')
          })()
        }}
      />

      <ConfirmDialog
        open={confirm === 'jais-download'}
        title={t('switchArtifact')}
        message={`${t('switchArtifactConfirm')} (${formatBytes(jais.totalBytes)})`}
        confirmLabel={t('switchArtifact')}
        cancelLabel={t('cancel')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null)
          void runDownload('jais')
        }}
      />
    </div>
  )
}
