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
} from './types'

export interface ProviderQuery {
  provider: ProviderId
  baseUrl?: string
  apiKey?: string
}

export interface ProviderTestQuery extends ProviderQuery {
  model?: string
}

export interface TafreeghAPI {
  app: {
    info: () => Promise<AppInfo>
    pickAudio: () => Promise<string | null>
    pathForFile: (file: File) => string
    fileInfo: (path: string) => Promise<AppFileInfo | null>
    copyText: (text: string) => Promise<void>
    revealPath: (path: string) => Promise<void>
    openExternal: (url: string) => Promise<void>
    onOpenFile: (callback: (path: string) => void) => () => void
  }
  setup: {
    status: () => Promise<SetupStatus>
    start: () => Promise<void>
    cancel: () => Promise<void>
    pickModelDir: () => Promise<string | null>
    useExistingModel: (dir: string) => Promise<SetupStatus>
    removeModels: () => Promise<void>
    downloadModel: (kind: ModelKind) => Promise<SetupStatus>
    pickModelPath: (kind: ModelKind) => Promise<SetupStatus | null>
    onProgress: (callback: (progress: SetupProgress) => void) => () => void
  }
  jobs: {
    list: () => Promise<JobSummary[]>
    start: (input: StartJobInput) => Promise<JobSummary>
    cancel: (id: string) => Promise<JobSummary>
    remove: (id: string) => Promise<void>
    retrySummary: (id: string) => Promise<JobSummary>
    renameSpeakers: (id: string, names: Record<string, string>) => Promise<JobSummary>
    openOutput: (id: string) => Promise<void>
    reveal: (id: string) => Promise<void>
    export: (id: string, kind: ExportKind) => Promise<ExportResult>
    onEvent: (callback: (event: JobEvent) => void) => () => void
  }
  settings: {
    get: () => Promise<Settings>
    update: (patch: Partial<Settings>) => Promise<Settings>
    setKey: (provider: ProviderId, key: string) => Promise<Settings>
    clearKey: (provider: ProviderId) => Promise<Settings>
    setHfToken: (token: string) => Promise<Settings>
    clearHfToken: () => Promise<Settings>
  }
  providers: {
    list: () => Promise<ProviderInfo[]>
    models: (query: ProviderQuery) => Promise<string[]>
    test: (query: ProviderTestQuery) => Promise<TestProviderResult>
  }
}

declare global {
  interface Window {
    tafreegh: TafreeghAPI
  }
}
