export type UiLanguage = 'ar' | 'en'

export type JobStatus =
  | 'queued'
  | 'running'
  | 'summarizing'
  | 'rendering'
  | 'done'
  | 'error'
  | 'cancelled'

export type StageId =
  | 'queued'
  | 'copy'
  | 'decode'
  | 'enhance'
  | 'diarize'
  | 'load'
  | 'transcribe'
  | 'audio'
  | 'artifacts'
  | 'summary'
  | 'render'
  | 'done'

export interface JobFiles {
  html?: string
  txt?: string
  audio?: string
  summary?: string
  transcriptJson?: string
}

export interface JobSummary {
  id: string
  title: string
  sourceName: string
  sourcePath: string
  createdAt: string
  updatedAt: string
  status: JobStatus
  stage: StageId
  durationSec?: number
  speechStart?: number
  speechEnd?: number
  speakers: string[]
  /** User-typed display names keyed by speaker letter ("A", "B", ...). */
  speakerNames?: Record<string, string>
  windows?: number
  language: string
  summaryProvider?: string
  summaryModel?: string
  summarizer?: SessionSummarizer
  hasSummary: boolean
  summaryError?: string
  error?: string
  files: JobFiles
  sizeBytes?: number
  progress?: JobProgress
}

export interface JobProgress {
  stage: StageId
  overall: number
  indeterminate: boolean
  message: string
  detail?: string
  window?: number
  windows?: number
  elapsedMs?: number
}

export type JobEvent =
  | { type: 'job'; job: JobSummary }
  | { type: 'progress'; jobId: string; progress: JobProgress }
  | { type: 'log'; jobId: string; line: string }
  | { type: 'summary-delta'; jobId: string; text: string }
  | { type: 'removed'; jobId: string }

export interface StartJobInput {
  filePath: string
  language: string
  enhance: boolean
  summarizer?: SessionSummarizer
}

export interface SessionSummarizer {
  provider: ProviderId | 'none'
  model?: string
}

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'qwen'
  | 'moonshot'
  | 'zhipu'
  | 'openrouter'
  | 'xai'
  | 'together'
  | 'fireworks'
  | 'ollama'
  | 'ollama-cloud'
  | 'lmstudio'
  | 'llamacpp'
  | 'vllm'
  | 'custom'

export interface ProviderInfo {
  id: ProviderId
  name: string
  nameAr: string
  kind: 'cloud' | 'local'
  requiresKey: boolean
  defaultBaseUrl: string
  docsUrl?: string
  models: string[]
  supportsModelList: boolean
  noteAr?: string
  noteEn?: string
}

export interface ProviderSettings {
  baseUrl?: string
  model?: string
  apiKeySet?: boolean
}

export interface SummarizerSettings {
  provider: ProviderId | 'none'
  model: string
  baseUrl?: string
  temperature: number
  maxTokens: number
}

export interface Settings {
  language: UiLanguage
  dialect: string
  enhance: boolean
  summarizer: SummarizerSettings
  providers: Partial<Record<ProviderId, ProviderSettings>>
  /** Read-only: a Hugging Face token is stored for model downloads. */
  hfTokenSet?: boolean
}

export interface GpuInfo {
  checked: boolean
  available: boolean
  name?: string
  vramMb?: number
  driver?: string
  /** Which backend the bundled llama.cpp will actually use. */
  acceleration?: 'cuda' | 'vulkan' | 'cpu'
  error?: string
}

export interface ModelStatus {
  present: boolean
  bytes: number
  /** Folder or file the app will actually use (app-owned or user-chosen). */
  path?: string
  /** True when the user pointed the app at their own copy. */
  custom?: boolean
}

/** The two GGUF quants of Jais-ASR the app can run through llama.cpp. */
export type JaisVariantId = 'gguf' | 'gguf-q8'

export interface SetupStatus {
  completed: boolean
  running: boolean
  phase?: SetupPhase
  error?: string
  mode?: 'managed' | 'existing'
  engine?: string
  gpu: GpuInfo
  disk: { freeGb?: number; requiredGb: number }
  runtime: {
    uv: boolean
    python: boolean
    venv: boolean
    deps: boolean
    pythonVersion?: string
    cuda?: boolean
  }
  models: {
    jais: ModelStatus & {
      totalBytes: number
      /** Collection artifact in place (or the one that would be downloaded). */
      variant?: JaisVariantId
      variantLabel?: string
      /** What the device profile picks automatically. */
      suggested?: JaisVariantId
      vramGb?: number
      wer?: number
    }
    diarizer: ModelStatus
  }
  paths: {
    dataRoot: string
    runtime: string
    models: string
    jobs: string
    logs: string
  }
}

export type ModelKind = 'jais' | 'diarizer'

export type SetupPhase =
  | 'check'
  | 'uv'
  | 'python'
  | 'deps'
  | 'probe'
  | 'jais'
  | 'diarizer'
  | 'done'

export interface SetupProgress {
  phase: SetupPhase
  pct: number
  indeterminate: boolean
  message: string
  detail?: string
  logLine?: string
  bytesDone?: number
  bytesTotal?: number
}

export type ExportKind = 'audio' | 'txt' | 'html' | 'summary'

export interface ExportResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

export interface TestProviderResult {
  ok: boolean
  latencyMs?: number
  models?: string[]
  error?: string
}

export interface AppInfo {
  version: string
  platform: string
  mock: boolean
  dataRoot: string
}

export interface AppFileInfo {
  path: string
  name: string
  size: number
  ext: string
}

export interface JobTranscriptLine {
  start: number
  end: number
  text: string
  speaker: string
}

export interface JobTranscript {
  duration: number
  speechStart: number
  speechEnd: number
  language: string
  model: string
  speakers: string[]
  windows: number
  lines: JobTranscriptLine[]
  turns: Array<{ start: number; end: number; speaker: string }>
}
