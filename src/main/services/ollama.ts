import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { net } from 'electron'

/**
 * Ollama lifecycle helpers.
 *
 * The app talks to Ollama over HTTP, so "using a local model" means three
 * things that used to be manual: the daemon has to be running, the model has to
 * be pulled, and the model has to be released again when we are done. All three
 * happen here so a local summary needs no terminal commands.
 */

const START_TIMEOUT_MS = 25_000
const PULL_TIMEOUT_MS = 6 * 60 * 60 * 1000
const CHAT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Ollama's own default window is 4096 tokens, which silently truncates Arabic
 * transcripts. 8k is the largest window that still fits a 6 GB card with a
 * 7B-class 4-bit model. Override with TAFREEGH_OLLAMA_CTX.
 */
export const LOCAL_CONTEXT = positiveInt(process.env.TAFREEGH_OLLAMA_CTX) ?? 8192

export type StatusSink = (message: string) => void

function positiveInt(value: string | undefined): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `http://127.0.0.1:11434/v1` -> `http://127.0.0.1:11434` for the native API. */
export function nativeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** Only a daemon on this machine is ours to start. */
export function isLocalBase(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/** Ollama treats `gemma4` and `gemma4:latest` as the same model. */
export function modelTag(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return trimmed
  return trimmed.includes(':') ? trimmed : `${trimmed}:latest`
}

/** Every installed model, or null when the daemon is not answering. */
export async function listOllamaModels(
  baseUrl: string,
  timeoutMs = 4_000
): Promise<string[] | null> {
  try {
    const res = await net.fetch(`${nativeBase(baseUrl)}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return null
    const json = (await res.json()) as { models?: Array<{ name?: string; model?: string }> }
    return (json.models ?? [])
      .map((model) => model.name ?? model.model ?? '')
      .filter(Boolean)
  } catch {
    return null
  }
}

function pathHasOllama(): string | null {
  const path = process.env.PATH ?? ''
  for (const dir of path.split(';')) {
    if (!dir) continue
    const candidate = join(dir, 'ollama.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** The installed `ollama.exe`, if there is one. Nothing is downloaded here. */
export function ollamaExe(): string | null {
  const local = process.env.LOCALAPPDATA
  const candidates = [
    process.env.TAFREEGH_OLLAMA_EXE,
    process.env.OLLAMA_EXE,
    local ? join(local, 'Programs', 'Ollama', 'ollama.exe') : undefined,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Ollama', 'ollama.exe') : undefined,
    process.env['ProgramFiles(x86)']
      ? join(process.env['ProgramFiles(x86)'], 'Ollama', 'ollama.exe')
      : undefined,
    local ? join(local, 'Ollama', 'ollama.exe') : undefined
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return pathHasOllama()
}

/** Start `ollama serve` detached and wait until the API answers. */
async function startServer(native: string): Promise<boolean> {
  const exe = ollamaExe()
  if (!exe) return false
  let failed = false
  try {
    const child = spawn(exe, ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.on('error', () => {
      failed = true
    })
    child.unref()
  } catch {
    return false
  }
  const deadline = Date.now() + START_TIMEOUT_MS
  while (!failed && Date.now() < deadline) {
    await sleep(500)
    const models = await listOllamaModels(native, 1_500)
    if (models) return true
  }
  return false
}

/**
 * Make sure a reachable Ollama is answering at this base URL, starting the
 * local daemon when it is installed but not running. Returns the native
 * (non-`/v1`) base URL.
 */
export async function ensureOllama(
  baseUrl: string,
  options: { autoStart?: boolean; onStatus?: StatusSink } = {}
): Promise<string> {
  const native = nativeBase(baseUrl)
  if (await listOllamaModels(native, 1_500)) return native

  if (options.autoStart !== false && isLocalBase(baseUrl) && ollamaExe()) {
    options.onStatus?.('تشغيل Ollama…')
    if (await startServer(native)) return native
  }

  if (!isLocalBase(baseUrl)) {
    throw new Error(`تعذّر الاتصال بـ Ollama على ${native}. تحقّق من العنوان أو من الشبكة.`)
  }
  throw new Error(
    'Ollama غير مشغّل ولم أستطع تشغيله تلقائيًا. ثبّته من ollama.com (يفتح نفسه بعد التثبيت) ثم أعد المحاولة.'
  )
}

function pullLabel(status: string | undefined, model: string): string {
  switch (status) {
    case 'pulling manifest':
      return 'تجهيز تنزيل النموذج…'
    case 'verifying sha256 digest':
      return 'التحقق من ملف النموذج…'
    case 'writing manifest':
      return 'تثبيت النموذج…'
    case 'removing any unused layers':
      return 'تنظيف الملفات المؤقتة…'
    case 'success':
      return 'اكتمل تنزيل النموذج'
    default:
      return `تنزيل ${model}…`
  }
}

interface PullEvent {
  error?: string
  status?: string
  total?: number
  completed?: number
}

async function consumePull(response: Response, model: string, onStatus?: StatusSink): Promise<void> {
  const body = response.body
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let shownPct = -1
  let lastMessage = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line) continue
      let event: PullEvent
      try {
        event = JSON.parse(line) as PullEvent
      } catch {
        continue
      }
      if (event.error) throw new Error(`تعذّر تنزيل ${model}: ${event.error}`)
      const hasProgress =
        typeof event.total === 'number' &&
        event.total > 0 &&
        typeof event.completed === 'number' &&
        event.completed >= 0
      if (hasProgress) {
        const pct = Math.min(100, Math.floor((event.completed! / event.total!) * 100))
        if (pct !== shownPct) {
          shownPct = pct
          lastMessage = `تنزيل ${model} — ${pct}%`
          onStatus?.(lastMessage)
        }
      } else if (event.status) {
        const message = pullLabel(event.status, model)
        if (message !== lastMessage) {
          lastMessage = message
          onStatus?.(message)
        }
      }
    }
  }
}

async function readOllamaError(response: Response, model: string): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const json = JSON.parse(text) as { error?: string }
    if (json.error) {
      if (/not found|try pulling/i.test(json.error)) {
        return `النموذج ${model} غير منزّل في Ollama، وتعذّر تنزيله (${json.error}).`
      }
      return json.error
    }
  } catch {
    // not json
  }
  return text || `HTTP ${response.status}`
}

/**
 * Pull the model when it is missing. Progress is reported through `onStatus`
 * so the job screen can show the download instead of looking frozen.
 */
export async function ensureOllamaModel(
  native: string,
  model: string,
  options: { autoPull?: boolean; onStatus?: StatusSink } = {}
): Promise<void> {
  const installed = (await listOllamaModels(native, 8_000)) ?? []
  const wanted = modelTag(model)
  if (installed.some((name) => modelTag(name) === wanted)) return

  if (options.autoPull === false) {
    throw new Error(
      `النموذج ${model} غير منزّل في Ollama. سيُنزَّل تلقائيًا عند أول ملخص، أو نفّذ: ollama pull ${model}`
    )
  }

  options.onStatus?.(`تنزيل ${model}…`)
  let response: Response
  try {
    response = await net.fetch(`${native}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
      signal: AbortSignal.timeout(PULL_TIMEOUT_MS)
    })
  } catch (error) {
    throw new Error(
      `تعذّر الاتصال بـ Ollama لتنزيل ${model}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!response.ok) throw new Error(await readOllamaError(response, model))
  await consumePull(response, model, options.onStatus)

  const after = (await listOllamaModels(native, 8_000)) ?? []
  if (!after.some((name) => modelTag(name) === wanted)) {
    throw new Error(`لم يكتمل تنزيل ${model}. تحقّق من المساحة والاتصال ثم أعد المحاولة.`)
  }
}

interface NativeChatReply {
  message?: { content?: string }
  done_reason?: string
  error?: string
}

/**
 * One chat turn through the native API, where `num_ctx` is honoured. Returns
 * null when the endpoint is not the native one (an OpenAI-only proxy), so the
 * caller can fall back to `/v1/chat/completions`.
 */
export async function ollamaChat(
  native: string,
  input: {
    model: string
    system: string
    user: string
    maxTokens: number
    temperature: number
    onStatus?: StatusSink
  }
): Promise<string | null> {
  input.onStatus?.('كتابة الملخص…')
  // Summarising needs the whole `num_predict` budget for the answer. Thinking
  // models (gemma4, qwen3) otherwise spend it on hidden reasoning and hand back
  // an empty `content`; the flag is ignored by models without thinking.
  const send = (thinking: boolean): Promise<Response> =>
    net.fetch(`${native}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user }
        ],
        stream: false,
        ...(thinking ? { think: false } : {}),
        options: {
          temperature: input.temperature,
          num_ctx: LOCAL_CONTEXT,
          num_predict: input.maxTokens
        }
      })
    })

  let response: Response
  try {
    response = await send(true)
    if (response.status === 400) {
      // A reasoning-only build (deepseek-r1 and friends) rejects the flag.
      const detail = await readOllamaError(response, input.model)
      if (/think/i.test(detail)) {
        response = await send(false)
      } else {
        throw new Error(detail)
      }
    }
  } catch (error) {
    throw new Error(
      `تعذّر تشغيل النموذج ${input.model} في Ollama: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (response.status === 404) return null
  if (!response.ok) throw new Error(await readOllamaError(response, input.model))

  const json = (await response.json()) as NativeChatReply
  if (json.error) throw new Error(json.error)
  const content = json.message?.content ?? ''
  if (!content.trim() && json.done_reason === 'length') {
    throw new Error('انتهى سياق النموذج قبل اكتمال الملخص. جرّب نموذجًا أكبر أو ملخصًا سحابيًا.')
  }
  return content
}

/**
 * Unload the model from VRAM. Called after a summary finishes so the GPU is
 * free for the next transcription on small cards.
 */
export async function releaseOllamaModel(baseUrl: string, model: string): Promise<void> {
  if (!model) return
  try {
    const response = await net.fetch(`${nativeBase(baseUrl)}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(15_000)
    })
    await response.text().catch(() => '')
  } catch {
    // best effort: Ollama also unloads on its own idle timer
  }
}
