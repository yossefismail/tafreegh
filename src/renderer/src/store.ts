import { create } from 'zustand'
import type {
  AppInfo,
  JobEvent,
  JobProgress,
  JobSummary,
  ModelKind,
  ProviderId,
  ProviderInfo,
  SessionSummarizer,
  Settings,
  SetupProgress,
  SetupStatus
} from '@shared/types'
import { translate, type MessageKey } from './i18n'

export type View = 'studio' | 'settings'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
}

interface AppState {
  initialized: boolean
  info: AppInfo | null
  settings: Settings | null
  setup: SetupStatus | null
  providers: ProviderInfo[]
  jobs: JobSummary[]
  activeId: string | null
  view: View
  setupProgress: SetupProgress | null
  setupLogs: string[]
  setupError: string | null
  /** True while `setup.start()` / a model download is in flight. */
  setupRunning: boolean
  setupFinishPending: boolean
  sessionSummarizer: SessionSummarizer | null
  logs: Record<string, string[]>
  toasts: Toast[]
  pendingFile: string | null
  bootError: string | null

  init: () => Promise<void>
  refreshSetup: () => Promise<void>
  downloadModel: (kind: ModelKind) => Promise<void>
  pickModelPath: (kind: ModelKind) => Promise<void>
  refreshJobs: () => Promise<void>
  setView: (view: View) => void
  selectJob: (id: string | null) => void
  setPendingFile: (path: string | null) => void
  startJob: (path: string) => Promise<void>
  cancelJob: (id: string) => Promise<void>
  removeJob: (id: string) => Promise<void>
  retrySummary: (id: string) => Promise<void>
  startSetup: () => Promise<void>
  useExistingModel: () => Promise<void>
  finishSetup: (choice: SessionSummarizer & { apiKey?: string }) => Promise<void>
  setSessionSummarizer: (choice: SessionSummarizer) => void
  cancelSetup: () => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  setApiKey: (provider: ProviderId, key: string) => Promise<void>
  clearApiKey: (provider: ProviderId) => Promise<void>
  setHfToken: (token: string) => Promise<void>
  clearHfToken: () => Promise<void>
  toast: (message: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
  t: (key: MessageKey) => string
}

let toastSeq = 0
const notified = new Set<string>()
let subscriptionsBound = false
const unsubscribes: Array<() => void> = []

/** Strip Electron's IPC wrapper so the UI shows the worker's own message. */
export function cleanErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    .trim()
}

function sortJobs(jobs: JobSummary[]): JobSummary[] {
  return [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export const useApp = create<AppState>((set, get) => ({
  initialized: false,
  info: null,
  settings: null,
  setup: null,
  providers: [],
  jobs: [],
  activeId: null,
  view: 'studio',
  setupProgress: null,
  setupLogs: [],
  setupError: null,
  setupRunning: false,
  setupFinishPending: false,
  sessionSummarizer: null,
  logs: {},
  toasts: [],
  pendingFile: null,
  bootError: null,

  t: (key) => translate(get().settings?.language ?? 'ar', key),

  toast: (message, kind = 'info') => {
    const id = ++toastSeq
    // Keep a short stack: repeated errors must not cover the page controls.
    set((state) => ({
      toasts: [...state.toasts, { id, kind, message: cleanErrorMessage(message) }].slice(-4)
    }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4200)
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },

  init: async () => {
    if (get().initialized) return
    try {
      const [info, settings, setup, jobs, providers] = await Promise.all([
        window.tafreegh.app.info(),
        window.tafreegh.settings.get(),
        window.tafreegh.setup.status(),
        window.tafreegh.jobs.list(),
        window.tafreegh.providers.list()
      ])
      set({
        info,
        settings,
        setup,
        jobs: sortJobs(jobs),
        providers,
        initialized: true,
        bootError: null,
        sessionSummarizer: {
          provider: settings.summarizer.provider,
          model: settings.summarizer.model
        }
      })
      if (!subscriptionsBound) {
        subscriptionsBound = true
        unsubscribes.push(
          window.tafreegh.setup.onProgress((progress) => {
            set((state) => ({
              setupProgress: progress,
              setupLogs: progress.logLine
                ? [...state.setupLogs.slice(-7), progress.logLine]
                : state.setupLogs
            }))
            if (progress.phase === 'done') {
              void get().refreshSetup()
            }
          })
        )
        unsubscribes.push(
          window.tafreegh.jobs.onEvent((event) => applyJobEvent(event, set, get))
        )
      }
    } catch (error) {
      set({
        initialized: true,
        bootError: cleanErrorMessage(error)
      })
    }
  },

  refreshSetup: async () => {
    try {
      const setup = await window.tafreegh.setup.status()
      set({ setup })
    } catch {
      // keep the previous snapshot
    }
  },

  downloadModel: async (kind) => {
    set({ setupRunning: true })
    try {
      const setup = await window.tafreegh.setup.downloadModel(kind)
      set({ setup })
    } catch (error) {
      get().toast(cleanErrorMessage(error), 'error')
    } finally {
      set({ setupRunning: false })
      void get().refreshSetup()
    }
  },

  pickModelPath: async (kind) => {
    try {
      const setup = await window.tafreegh.setup.pickModelPath(kind)
      if (setup) {
        set({ setup })
        get().toast(get().t('modelPathSaved'), 'success')
      }
    } catch (error) {
      get().toast(cleanErrorMessage(error), 'error')
    }
  },

  refreshJobs: async () => {
    try {
      const jobs = await window.tafreegh.jobs.list()
      set({ jobs: sortJobs(jobs) })
    } catch {
      // keep the previous snapshot
    }
  },

  setView: (view) => set({ view }),
  selectJob: (id) => set({ activeId: id, view: 'studio' }),
  setPendingFile: (path) => set({ pendingFile: path }),

  startJob: async (path) => {
    const { settings, setup, t } = get()
    if (!setup?.completed) {
      get().toast(t('setupRequired'), 'error')
      return
    }
    if (!settings) return
    try {
      const job = await window.tafreegh.jobs.start({
        filePath: path,
        language: settings.dialect,
        enhance: settings.enhance,
        summarizer: get().sessionSummarizer ?? undefined
      })
      notified.delete(job.id)
      set((state) => ({
        jobs: sortJobs([job, ...state.jobs.filter((item) => item.id !== job.id)]),
        activeId: job.id,
        view: 'studio',
        pendingFile: null
      }))
      get().toast(t('toastJobStarted'), 'info')
    } catch (error) {
      get().toast(cleanErrorMessage(error), 'error')
    }
  },

  cancelJob: async (id) => {
    try {
      const job = await window.tafreegh.jobs.cancel(id)
      set((state) => ({
        jobs: state.jobs.map((item) => (item.id === id ? job : item))
      }))
    } catch (error) {
      get().toast(cleanErrorMessage(error), 'error')
    }
  },

  removeJob: async (id) => {
    try {
      await window.tafreegh.jobs.remove(id)
      set((state) => ({
        jobs: state.jobs.filter((item) => item.id !== id),
        activeId: state.activeId === id ? null : state.activeId
      }))
      get().toast(get().t('deleted'), 'success')
    } catch (error) {
      get().toast(cleanErrorMessage(error), 'error')
    }
  },

  retrySummary: async (id) => {
    const { t } = get()
    get().toast(t('summaryRetryStarted'), 'info')
    try {
      const job = await window.tafreegh.jobs.retrySummary(id)
      set((state) => ({
        jobs: state.jobs.map((item) => (item.id === id ? job : item))
      }))
      if (job.hasSummary) get().toast(t('summaryRetryDone'), 'success')
      else if (job.summaryError) get().toast(job.summaryError, 'error')
    } catch (error) {
      get().toast(cleanErrorMessage(error), 'error')
    }
  },

  startSetup: async () => {
    set({ setupLogs: [], setupProgress: null, setupError: null, setupRunning: true })
    try {
      await window.tafreegh.setup.start()
      const status = await window.tafreegh.setup.status()
      set({
        setup: status,
        setupProgress: null,
        setupRunning: false,
        setupFinishPending: status.completed
      })
      if (status.completed) {
        get().toast(get().t('toastSetupDone'), 'success')
      } else {
        get().toast(get().t('setupCancelled'), 'info')
      }
    } catch (error) {
      const message = cleanErrorMessage(error)
      set({ setupProgress: null, setupError: message, setupRunning: false })
      await get().refreshSetup()
      get().toast(message, 'error')
    }
  },

  useExistingModel: async () => {
    try {
      const dir = await window.tafreegh.setup.pickModelDir()
      if (!dir) return
      const status = await window.tafreegh.setup.useExistingModel(dir)
      set({ setup: status, setupError: null, setupFinishPending: status.completed })
      get().toast(
        status.completed ? get().t('toastExistingReady') : get().t('toastExistingEngineOnly'),
        status.completed ? 'success' : 'info'
      )
    } catch (error) {
      const message = cleanErrorMessage(error)
      set({ setupError: message })
      get().toast(message, 'error')
    }
  },

  finishSetup: async (choice) => {
    const { t } = get()
    try {
      if (choice.apiKey && choice.provider !== 'none') {
        const withKey = await window.tafreegh.settings.setKey(choice.provider, choice.apiKey)
        set({ settings: withKey })
      }
      const current = get().settings?.summarizer
      const settings = await window.tafreegh.settings.update({
        summarizer: {
          provider: choice.provider,
          model: choice.model ?? '',
          baseUrl: current?.baseUrl ?? '',
          temperature: current?.temperature ?? 0.2,
          maxTokens: current?.maxTokens ?? 2500
        }
      })
      set({
        settings,
        setupFinishPending: false,
        sessionSummarizer: { provider: choice.provider, model: choice.model }
      })
      get().toast(t('toastSetupDone'), 'success')
    } catch (error) {
      get().toast(cleanErrorMessage(error), 'error')
    }
  },

  setSessionSummarizer: (choice) => set({ sessionSummarizer: choice }),

  cancelSetup: async () => {
    try {
      await window.tafreegh.setup.cancel()
      await get().refreshSetup()
    } catch {
      // ignore
    }
  },

  updateSettings: async (patch) => {
    try {
      const settings = await window.tafreegh.settings.update(patch)
      set({ settings })
    } catch (error) {
      get().toast(cleanErrorMessage(error), 'error')
    }
  },

  setApiKey: async (provider, key) => {
    try {
      const settings = await window.tafreegh.settings.setKey(provider, key)
      set({ settings })
      get().toast(get().t('keySaved'), 'success')
    } catch (error) {
      get().toast(cleanErrorMessage(error), 'error')
    }
  },

  clearApiKey: async (provider) => {
    try {
      const settings = await window.tafreegh.settings.clearKey(provider)
      set({ settings })
      get().toast(get().t('keyCleared'), 'info')
    } catch (error) {
      get().toast(cleanErrorMessage(error), 'error')
    }
  },

  setHfToken: async (token) => {
    try {
      const settings = await window.tafreegh.settings.setHfToken(token)
      set({ settings })
      get().toast(get().t('hfTokenSavedToast'), 'success')
    } catch (error) {
      get().toast(cleanErrorMessage(error), 'error')
    }
  },

  clearHfToken: async () => {
    try {
      const settings = await window.tafreegh.settings.clearHfToken()
      set({ settings })
      get().toast(get().t('hfTokenCleared'), 'info')
    } catch (error) {
      get().toast(cleanErrorMessage(error), 'error')
    }
  }
}))

function applyJobEvent(
  event: JobEvent,
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState
): void {
  if (event.type === 'removed') {
    set((state) => ({
      jobs: state.jobs.filter((job) => job.id !== event.jobId),
      activeId: state.activeId === event.jobId ? null : state.activeId
    }))
    return
  }
  if (event.type === 'progress') {
    set((state) => ({
      jobs: state.jobs.map((job) =>
        job.id === event.jobId
          ? {
              ...job,
              progress: event.progress,
              stage: event.progress.stage,
              status:
                event.progress.stage === 'summary'
                  ? 'summarizing'
                  : event.progress.stage === 'render'
                    ? 'rendering'
                    : event.progress.stage === 'done'
                      ? job.status
                      : job.status === 'queued'
                        ? 'running'
                        : job.status
            }
          : job
      )
    }))
    return
  }
  if (event.type === 'log') {
    set((state) => ({
      logs: {
        ...state.logs,
        [event.jobId]: [...(state.logs[event.jobId] ?? []).slice(-7), event.line]
      }
    }))
    return
  }
  if (event.type === 'job') {
    const job = event.job
    set((state) => ({
      jobs: sortJobs([job, ...state.jobs.filter((item) => item.id !== job.id)])
    }))
    const t = get().t
    if (job.status === 'done' && !notified.has(job.id)) {
      notified.add(job.id)
      get().toast(t('toastJobDone'), 'success')
    } else if (job.status === 'error' && !notified.has(job.id)) {
      notified.add(job.id)
      get().toast(job.error || t('toastJobFailed'), 'error')
    }
  }
}

export function disposeSubscriptions(): void {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe()
  subscriptionsBound = false
}

export function useT(): (key: MessageKey) => string {
  const lang = useApp((state) => state.settings?.language ?? 'ar')
  return (key: MessageKey) => translate(lang, key)
}

export function useLanguage(): 'ar' | 'en' {
  return useApp((state) => state.settings?.language ?? 'ar')
}

export function activeJobOf(state: AppState): JobSummary | null {
  return state.jobs.find((job) => job.id === state.activeId) ?? null
}

export function progressOf(job: JobSummary | null): JobProgress | null {
  return job?.progress ?? null
}
