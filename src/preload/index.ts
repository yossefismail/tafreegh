import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { TafreeghAPI } from '../shared/api'
import type {
  AppFileInfo,
  AppInfo,
  ExportKind,
  ExportResult,
  JobEvent,
  JobSummary,
  ModelKind,
  ProviderId,
  ProviderInfo,
  Settings,
  SetupProgress,
  SetupStatus,
  StartJobInput,
  TestProviderResult
} from '../shared/types'
import { IPC } from '../shared/ipc'
import { ipcErrorMessage } from '../shared/ipcError'

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T): void => callback(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/**
 * Electron wraps main-process rejections as
 * `Error invoking remote method '<channel>': Error: <real message>`, and the
 * renderer displays `error.message` verbatim. Strip the wrapper so failures
 * from the setup/worker layer stay readable.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (error) {
    throw new Error(ipcErrorMessage(error))
  }
}

const api: TafreeghAPI = {
  app: {
    info: () => invoke<AppInfo>(IPC.appInfo),
    pickAudio: () => invoke<string | null>(IPC.appPickAudio),
    pathForFile: (file: File) => webUtils.getPathForFile(file),
    fileInfo: (path: string) => invoke<AppFileInfo | null>(IPC.appFileInfo, path),
    copyText: (text: string) => invoke<void>(IPC.appCopyText, text),
    revealPath: (path: string) => invoke<void>(IPC.appRevealPath, path),
    openExternal: (url: string) => invoke<void>(IPC.appOpenExternal, url),
    onOpenFile: (callback: (path: string) => void) => subscribe<string>(IPC.appOpenFile, callback)
  },
  setup: {
    status: () => invoke<SetupStatus>(IPC.setupStatus),
    start: () => invoke<void>(IPC.setupStart),
    cancel: () => invoke<void>(IPC.setupCancel),
    pickModelDir: () => invoke<string | null>(IPC.setupPickModelDir),
    useExistingModel: (dir: string) => invoke<SetupStatus>(IPC.setupUseExistingModel, dir),
    removeModels: () => invoke<void>(IPC.setupRemoveModels),
    downloadModel: (kind: ModelKind) => invoke<SetupStatus>(IPC.setupDownloadModel, kind),
    pickModelPath: (kind: ModelKind) => invoke<SetupStatus | null>(IPC.setupPickModelPath, kind),
    onProgress: (callback: (progress: SetupProgress) => void) =>
      subscribe<SetupProgress>(IPC.setupEvent, callback)
  },
  jobs: {
    list: () => invoke<JobSummary[]>(IPC.jobsList),
    start: (input: StartJobInput) => invoke<JobSummary>(IPC.jobsStart, input),
    cancel: (id: string) => invoke<JobSummary>(IPC.jobsCancel, id),
    remove: (id: string) => invoke<void>(IPC.jobsRemove, id),
    retrySummary: (id: string) => invoke<JobSummary>(IPC.jobsRetrySummary, id),
    renameSpeakers: (id: string, names: Record<string, string>) =>
      invoke<JobSummary>(IPC.jobsRenameSpeakers, id, names),
    openOutput: (id: string) => invoke<void>(IPC.jobsOpenOutput, id),
    reveal: (id: string) => invoke<void>(IPC.jobsReveal, id),
    export: (id: string, kind: ExportKind) => invoke<ExportResult>(IPC.jobsExport, id, kind),
    onEvent: (callback: (event: JobEvent) => void) => subscribe<JobEvent>(IPC.jobsEvent, callback)
  },
  settings: {
    get: () => invoke<Settings>(IPC.settingsGet),
    update: (patch: Partial<Settings>) => invoke<Settings>(IPC.settingsUpdate, patch),
    setKey: (provider: ProviderId, key: string) =>
      invoke<Settings>(IPC.settingsSetKey, provider, key),
    clearKey: (provider: ProviderId) => invoke<Settings>(IPC.settingsClearKey, provider),
    setHfToken: (token: string) => invoke<Settings>(IPC.settingsSetHfToken, token),
    clearHfToken: () => invoke<Settings>(IPC.settingsClearHfToken)
  },
  providers: {
    list: () => invoke<ProviderInfo[]>(IPC.providersList),
    models: (query) => invoke<string[]>(IPC.providersModels, query),
    test: (query) => invoke<TestProviderResult>(IPC.providersTest, query)
  }
}

contextBridge.exposeInMainWorld('tafreegh', api)
