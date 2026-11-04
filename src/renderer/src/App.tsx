import { useEffect, useRef, useState } from 'react'
import { isAudioPath } from '@shared/languages'
import { useApp, useLanguage, useT } from './store'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { BrandMark, Icon } from './components/Icon'
import { ToastStack } from './components/Overlays'
import { HomeView } from './views/HomeView'
import { ProgressView } from './views/ProgressView'
import { ResultView } from './views/ResultView'
import { SettingsView } from './views/SettingsView'
import { SetupWizard } from './views/SetupWizard'

export function App(): React.JSX.Element {
  const initialized = useApp((state) => state.initialized)
  const bootError = useApp((state) => state.bootError)
  const info = useApp((state) => state.info)
  const setup = useApp((state) => state.setup)
  const setupFinishPending = useApp((state) => state.setupFinishPending)
  const settings = useApp((state) => state.settings)
  const jobs = useApp((state) => state.jobs)
  const activeId = useApp((state) => state.activeId)
  const view = useApp((state) => state.view)
  const init = useApp((state) => state.init)
  const toast = useApp((state) => state.toast)
  const t = useT()
  const language = useLanguage()
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    document.documentElement.lang = language
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'
  }, [language])

  useEffect(() => {
    if (info) document.documentElement.dataset.platform = info.platform
  }, [info])

  useEffect(() => {
    return window.tafreegh.app.onOpenFile((path) => {
      if (!isAudioPath(path)) {
        useApp.getState().toast(useApp.getState().t('unsupportedFile'), 'error')
        return
      }
      useApp.getState().setPendingFile(path)
      useApp.getState().selectJob(null)
      useApp.getState().setView('studio')
    })
  }, [])

  useEffect(() => {
    // A drag can end without a `drop` reaching us (released outside the window,
    // dropped on a child that swallowed the event, window lost focus). This
    // watchdog hides the overlay if no `dragover` arrives for a moment.
    let hideTimer: number | undefined
    const clearTimer = (): void => {
      if (hideTimer !== undefined) {
        window.clearTimeout(hideTimer)
        hideTimer = undefined
      }
    }
    const stopDragging = (): void => {
      clearTimer()
      dragDepth.current = 0
      setDragging(false)
    }
    const armWatchdog = (): void => {
      clearTimer()
      hideTimer = window.setTimeout(stopDragging, 1200)
    }
    const hasFiles = (event: DragEvent): boolean =>
      Boolean(event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files'))
    const onDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current += 1
      setDragging(true)
      armWatchdog()
    }
    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      armWatchdog()
    }
    const onDragLeave = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) stopDragging()
    }
    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      stopDragging()
      const file = event.dataTransfer?.files?.[0]
      if (!file) return
      const path = window.tafreegh.app.pathForFile(file)
      if (!path || !isAudioPath(path)) {
        toast(t('unsupportedFile'), 'error')
        return
      }
      useApp.getState().setPendingFile(path)
      useApp.getState().selectJob(null)
      useApp.getState().setView('studio')
    }
    // Capture phase: the overlay is pointer-events:none, so a drop lands on the
    // element underneath, and a child calling stopPropagation() used to keep the
    // overlay on screen forever.
    const options = { capture: true }
    window.addEventListener('dragenter', onDragEnter, options)
    window.addEventListener('dragover', onDragOver, options)
    window.addEventListener('dragleave', onDragLeave, options)
    window.addEventListener('drop', onDrop, options)
    window.addEventListener('blur', stopDragging)
    return () => {
      clearTimer()
      window.removeEventListener('dragenter', onDragEnter, options)
      window.removeEventListener('dragover', onDragOver, options)
      window.removeEventListener('dragleave', onDragLeave, options)
      window.removeEventListener('drop', onDrop, options)
      window.removeEventListener('blur', stopDragging)
    }
  }, [toast, t])

  if (!initialized) {
    return (
      <div className="boot">
        <BrandMark size={44} />
        <div className="boot__word">{t('appName')}</div>
        <div className="boot__line" />
        <div className="boot__row">
          <span className="spinner" />
          <span className="tech tech--muted">{t('loadingStudio')}</span>
        </div>
      </div>
    )
  }

  if (bootError) {
    return (
      <div className="center-stage">
        <div className="empty-card">
          <h2>{t('error')}</h2>
          <p>{bootError}</p>
          <div className="alert-row" style={{ justifyContent: 'center', marginTop: 16 }}>
            <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
              <Icon name="refresh" size={16} />
              {t('retry')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!setup || !settings) {
    return (
      <div className="boot">
        <BrandMark size={44} />
        <div className="boot__row">
          <span className="spinner" />
          <span className="tech tech--muted">{t('preparing')}</span>
        </div>
      </div>
    )
  }

  const showSetup = !setup.completed || setup.running || setupFinishPending
  if (showSetup) {
    return (
      <>
        <SetupWizard />
        <ToastStack />
      </>
    )
  }

  const activeJob = jobs.find((job) => job.id === activeId) ?? null
  const inSettings = view === 'settings'

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <TopBar job={inSettings ? null : activeJob} />
        <main className="workspace scroll">
          {inSettings ? (
            <SettingsView />
          ) : activeJob ? (
            activeJob.status === 'done' ? (
              <ResultView job={activeJob} />
            ) : (
              <ProgressView job={activeJob} />
            )
          ) : (
            <HomeView />
          )}
        </main>
      </div>

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay__frame">
            <span className="dropzone__corner dropzone__corner--tl" />
            <span className="dropzone__corner dropzone__corner--tr" />
            <span className="dropzone__corner dropzone__corner--bl" />
            <span className="dropzone__corner dropzone__corner--br" />
            <Icon name="waveform" size={56} strokeWidth={1.1} />
            <p className="drop-overlay__title">{t('dropActive')}</p>
            <p className="tech tech--muted">{t('formats')}</p>
          </div>
        </div>
      )}

      <ToastStack />
    </div>
  )
}
