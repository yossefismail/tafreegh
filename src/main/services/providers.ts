import { net } from 'electron'
import type {
  ProviderId,
  ProviderInfo,
  Settings,
  TestProviderResult
} from '../../shared/types'
import {
  ensureOllama,
  ensureOllamaModel,
  listOllamaModels,
  ollamaChat,
  releaseOllamaModel,
  type StatusSink
} from './ollama'
import type { SettingsStore } from './settings'

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    nameAr: 'أوبن إيه آي',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-5.1', 'gpt-5.1-mini', 'gpt-5', 'gpt-4.1', 'gpt-4o'],
    supportsModelList: true
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    nameAr: 'أنثروبيك',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-0'],
    supportsModelList: true
  },
  {
    id: 'google',
    name: 'Google Gemini',
    nameAr: 'جوجل جيميناي',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    models: ['gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    supportsModelList: true
  },
  {
    id: 'groq',
    name: 'Groq',
    nameAr: 'جروك',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    docsUrl: 'https://console.groq.com/keys',
    models: [
      'openai/gpt-oss-120b',
      'meta-llama/llama-4-maverick-17b-128e-instruct',
      'qwen/qwen3-32b'
    ],
    supportsModelList: true
  },
  {
    id: 'mistral',
    name: 'Mistral',
    nameAr: 'ميسترال',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    docsUrl: 'https://console.mistral.ai/api-keys/',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'magistral-medium-latest'],
    supportsModelList: true
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    nameAr: 'ديب سيك',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    supportsModelList: true,
    noteAr: 'صيني — قوي في العربية وسعر منخفض',
    noteEn: 'Chinese — strong Arabic, low cost'
  },
  {
    id: 'qwen',
    name: 'Qwen (Alibaba)',
    nameAr: 'كوين — علي بابا',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    docsUrl: 'https://bailian.console.alibabacloud.com/',
    models: ['qwen3-max', 'qwen-max', 'qwen-plus', 'qwen-turbo'],
    supportsModelList: false,
    noteAr: 'صيني — نماذج Qwen من علي بابا',
    noteEn: 'Chinese — Alibaba Qwen models'
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    nameAr: 'مونشوت — كيمي',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    docsUrl: 'https://platform.moonshot.ai/console/api-keys',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-128k', 'moonshot-v1-32k'],
    supportsModelList: true,
    noteAr: 'صيني — سياق طويل، مناسب للتفريغات الطويلة',
    noteEn: 'Chinese — long context for long transcripts'
  },
  {
    id: 'zhipu',
    name: 'Zhipu AI (GLM)',
    nameAr: 'تشيبو — GLM',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4-plus'],
    supportsModelList: false,
    noteAr: 'صيني — نماذج GLM',
    noteEn: 'Chinese — GLM models'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    nameAr: 'أوبن راوتر',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/keys',
    models: [
      'openai/gpt-5.1',
      'anthropic/claude-sonnet-4.5',
      'google/gemini-3-flash-preview',
      'qwen/qwen3-235b-a22b',
      'deepseek/deepseek-chat'
    ],
    supportsModelList: true,
    noteAr: 'مفتاح واحد لعشرات النماذج',
    noteEn: 'One key, many models'
  },
  {
    id: 'xai',
    name: 'xAI',
    nameAr: 'إكس إيه آي',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
    docsUrl: 'https://console.x.ai/',
    models: ['grok-4', 'grok-4-fast', 'grok-3'],
    supportsModelList: true
  },
  {
    id: 'together',
    name: 'Together AI',
    nameAr: 'توغيدر',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://api.together.xyz/v1',
    docsUrl: 'https://api.together.ai/settings/api-keys',
    models: [
      'Qwen/Qwen3-235B-A22B-Instruct-2507',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'deepseek-ai/DeepSeek-V3.1'
    ],
    supportsModelList: true
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    nameAr: 'فايروركس',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    docsUrl: 'https://fireworks.ai/account/api-keys',
    models: [
      'accounts/fireworks/models/qwen3-235b-a22b',
      'accounts/fireworks/models/llama-v3p3-70b-instruct'
    ],
    supportsModelList: true
  },
  {
    id: 'ollama',
    name: 'Ollama',
    nameAr: 'أولاما',
    kind: 'local',
    requiresKey: false,
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    docsUrl: 'https://ollama.com/download',
    models: [
      'gemma4:e4b',
      'gemma4:e2b',
      'gemma4:12b',
      'gemma4:31b',
      'qwen3:14b',
      'qwen3:8b',
      'aya-expanse:32b'
    ],
    supportsModelList: true,
    noteAr: 'محلي بالكامل — مجاني وخاص',
    noteEn: 'Fully local — free and private'
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    nameAr: 'أولاما كلاود',
    kind: 'cloud',
    requiresKey: true,
    defaultBaseUrl: 'https://ollama.com/v1',
    docsUrl: 'https://ollama.com/settings/keys',
    models: [
      'gemma4:31b-cloud',
      'gpt-oss:120b-cloud',
      'qwen3-coder:480b-cloud',
      'deepseek-v3.1:671b-cloud',
      'glm-5.3-flash:cloud'
    ],
    supportsModelList: false,
    noteAr: 'نماذج كبيرة على سحابة Ollama بمفتاح واحد',
    noteEn: 'Large models on Ollama Cloud with one key'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    nameAr: 'إل إم ستوديو',
    kind: 'local',
    requiresKey: false,
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    docsUrl: 'https://lmstudio.ai/',
    models: ['local-model'],
    supportsModelList: true,
    noteAr: 'شغّل الخادم المحلي في LM Studio',
    noteEn: 'Start the local server in LM Studio'
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp',
    nameAr: 'لاما سي بي بي',
    kind: 'local',
    requiresKey: false,
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    models: ['local-model'],
    supportsModelList: true,
    noteAr: 'خادم llama-server متوافق مع OpenAI',
    noteEn: 'OpenAI-compatible llama-server'
  },
  {
    id: 'vllm',
    name: 'vLLM',
    nameAr: 'في إل إل إم',
    kind: 'local',
    requiresKey: false,
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    models: ['local-model'],
    supportsModelList: true,
    noteAr: 'خادم vLLM محلي',
    noteEn: 'Local vLLM server'
  },
  {
    id: 'custom',
    name: 'Custom endpoint',
    nameAr: 'نقطة نهاية مخصصة',
    kind: 'local',
    requiresKey: false,
    defaultBaseUrl: '',
    models: [],
    supportsModelList: true,
    noteAr: 'أي خادم متوافق مع OpenAI',
    noteEn: 'Any OpenAI-compatible server'
  }
]

export function providerInfo(id: ProviderId): ProviderInfo {
  const found = PROVIDERS.find((p) => p.id === id)
  if (!found) throw new Error(`unknown provider: ${id}`)
  return found
}

export interface ProviderInput {
  provider: ProviderId
  baseUrl?: string
  apiKey?: string
  model?: string
  settings: Settings
}

function baseUrlFor(input: ProviderInput): string {
  const info = providerInfo(input.provider)
  const stored = input.settings.providers[input.provider]?.baseUrl
  const url = input.baseUrl || stored || info.defaultBaseUrl
  return url.replace(/\/+$/, '')
}

function modelFor(input: ProviderInput): string {
  const info = providerInfo(input.provider)
  const stored = input.settings.providers[input.provider]?.model
  const configured =
    input.settings.summarizer.provider === input.provider ? input.settings.summarizer.model : ''
  return (input.model || configured || stored || info.models[0] || '').trim()
}

export function keyFor(input: ProviderInput, store: SettingsStore): string | undefined {
  const typed = input.apiKey?.trim()
  if (typed) return typed
  // Never send a stored secret to an endpoint the renderer chose. The saved key
  // is only released to the URL it was saved for (or the provider default), so
  // a compromised renderer cannot redirect credentials to its own host.
  const info = providerInfo(input.provider)
  const trim = (value: string | undefined): string => (value ?? '').replace(/\/+$/, '')
  const requested = trim(input.baseUrl)
  const stored = trim(input.settings.providers[input.provider]?.baseUrl)
  const trusted = !requested || requested === stored || requested === trim(info.defaultBaseUrl)
  return trusted ? store.getApiKey(input.provider) : undefined
}

function redact(text: string, key?: string): string {
  let out = text
  if (key && key.length > 6) out = out.split(key).join('••••')
  return out.replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-••••').slice(0, 700)
}

async function readError(response: Response, key?: string): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    const error = json.error as Record<string, unknown> | string | undefined
    if (typeof error === 'string') return redact(error, key)
    if (error && typeof error.message === 'string') return redact(error.message, key)
    if (typeof json.message === 'string') return redact(json.message, key)
  } catch {
    // not json
  }
  return redact(text || `HTTP ${response.status}`, key)
}

function headersFor(input: ProviderInput, key?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const info = providerInfo(input.provider)
  if (info.id === 'anthropic') {
    if (key) headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
  } else if (key) {
    headers.authorization = `Bearer ${key}`
  }
  if (info.id === 'openrouter') {
    headers['HTTP-Referer'] = 'https://tafreegh.app'
    headers['X-Title'] = 'Tafreegh'
  }
  return headers
}

async function parseModels(input: ProviderInput, key?: string): Promise<string[]> {
  const info = providerInfo(input.provider)
  const base = baseUrlFor(input)
  if (!base) throw new Error('أدخل عنوان الخادم أولًا')
  const signal = AbortSignal.timeout(20_000)

  if (info.id === 'ollama') {
    // Auto-start a local daemon so listing models works without a terminal.
    const native = await ensureOllama(base, { autoStart: true }).catch(() => null)
    if (native) {
      const names = await listOllamaModels(native)
      if (names?.length) return names.sort()
    }
  }

  if (info.id === 'google') {
    const res = await net.fetch(`${base}/models?key=${encodeURIComponent(key ?? '')}`, { signal })
    if (!res.ok) throw new Error(await readError(res, key))
    const json = (await res.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>
    }
    return (json.models ?? [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort()
  }

  const url = info.id === 'anthropic' ? `${base}/models?limit=100` : `${base}/models`
  const res = await net.fetch(url, { headers: headersFor(input, key), signal })
  if (!res.ok) throw new Error(await readError(res, key))
  const json = (await res.json()) as {
    data?: Array<{ id?: string }>
    models?: Array<{ id?: string; name?: string }>
  }
  const rows = json.data ?? json.models ?? []
  return rows
    .map((m) => {
      const entry = m as { id?: string; name?: string }
      return entry.id || entry.name || ''
    })
    .filter(Boolean)
    .sort()
}

function normaliseBase(input: ProviderInput): string {
  const base = baseUrlFor(input)
  if (!base) throw new Error('أدخل عنوان الخادم أولًا')
  if (!/^https?:\/\//i.test(base)) throw new Error('يجب أن يبدأ العنوان بـ http:// أو https://')
  return base
}

async function chatWithProvider(
  input: ProviderInput & {
    model: string
    system: string
    user: string
    maxTokens: number
    temperature: number
    onStatus?: StatusSink
    autoPull?: boolean
  },
  key?: string
): Promise<string> {
  const info = providerInfo(input.provider)
  const base = normaliseBase(input)
  const signal = AbortSignal.timeout(180_000)

  if (info.id === 'ollama') {
    // Start the daemon, pull a missing model, then chat with a real context
    // window. Falls through to the OpenAI surface for non-Ollama servers.
    const native = await ensureOllama(base, { autoStart: true, onStatus: input.onStatus })
    await ensureOllamaModel(native, input.model, {
      autoPull: input.autoPull !== false,
      onStatus: input.onStatus
    })
    const reply = await ollamaChat(native, input)
    if (reply !== null) return reply
  }

  if (info.id === 'anthropic') {
    const res = await net.fetch(`${base}/messages`, {
      method: 'POST',
      headers: headersFor(input, key),
      signal,
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        system: input.system,
        messages: [{ role: 'user', content: input.user }]
      })
    })
    if (!res.ok) throw new Error(await readError(res, key))
    const json = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>
    }
    return (json.content ?? [])
      .filter((block) => block.type === 'text' || block.text)
      .map((block) => block.text ?? '')
      .join('\n')
  }

  if (info.id === 'google') {
    const res = await net.fetch(
      `${base}/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(key ?? '')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.system }] },
          contents: [{ role: 'user', parts: [{ text: input.user }] }],
          generationConfig: {
            temperature: input.temperature,
            maxOutputTokens: input.maxTokens
          }
        })
      }
    )
    if (!res.ok) throw new Error(await readError(res, key))
    const json = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> }
        finishReason?: string
      }>
      promptFeedback?: { blockReason?: string }
    }
    if (json.promptFeedback?.blockReason) {
      throw new Error(`حجب المزود الطلب (${json.promptFeedback.blockReason})`)
    }
    const candidate = json.candidates?.[0]
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('')
    if (!text && candidate?.finishReason === 'MAX_TOKENS') {
      throw new Error('انتهت حصة الإخراج قبل اكتمال الملخص')
    }
    return text
  }

  const body: Record<string, unknown> = {
    model: input.model,
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user }
    ],
    stream: false
  }
  if (info.id === 'openai') {
    body.max_completion_tokens = input.maxTokens
    if (!/^(o\d|gpt-5)/i.test(input.model)) body.temperature = input.temperature
  } else {
    body.max_tokens = input.maxTokens
    body.temperature = input.temperature
  }

  const res = await net.fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: headersFor(input, key),
    signal,
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(await readError(res, key))
  const json = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string | Array<{ type?: string; text?: string }> }
      finish_reason?: string
    }>
  }
  const content = json.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('')
  return ''
}

export class ProvidersService {
  constructor(private store: SettingsStore) {}

  infos(): ProviderInfo[] {
    return PROVIDERS
  }

  async listModels(input: {
    provider: ProviderId
    baseUrl?: string
    apiKey?: string
  }): Promise<string[]> {
    const settings = this.store.get()
    const providerInput: ProviderInput = { ...input, settings }
    const key = keyFor(providerInput, this.store)
    const info = providerInfo(input.provider)
    if (info.requiresKey && !key) {
      throw new Error('أدخل مفتاح API أولًا')
    }
    return parseModels(providerInput, key)
  }

  async test(input: {
    provider: ProviderId
    baseUrl?: string
    apiKey?: string
    model?: string
  }): Promise<TestProviderResult> {
    const started = Date.now()
    try {
      const settings = this.store.get()
      const providerInput: ProviderInput = { ...input, settings }
      const key = keyFor(providerInput, this.store)
      const info = providerInfo(input.provider)
      if (info.requiresKey && !key) return { ok: false, error: 'أدخل مفتاح API أولًا' }
      let model = modelFor(providerInput)
      if (!model) {
        const models = await parseModels(providerInput, key)
        model = models[0]
      }
      if (!model) return { ok: false, error: 'اختر نموذجًا أو حمّل قائمة النماذج' }
      let text: string
      try {
        text = await chatWithProvider(
          {
            ...providerInput,
            model,
            system: 'أجب بكلمة واحدة فقط.',
            user: 'اكتب: جاهز',
            maxTokens: 24,
            temperature: 0,
            autoPull: false
          },
          key
        )
      } finally {
        // A test must not keep the model resident on the GPU.
        if (info.id === 'ollama') await releaseOllamaModel(baseUrlFor(providerInput), model)
      }
      return {
        ok: Boolean(text.trim()),
        latencyMs: Date.now() - started,
        models: [model],
        error: text.trim() ? undefined : 'وصل رد فارغ من المزود'
      }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async complete(input: {
    provider: ProviderId
    baseUrl?: string
    apiKey?: string
    model: string
    system: string
    user: string
    maxTokens: number
    temperature: number
    retries?: number
    onStatus?: StatusSink
  }): Promise<string> {
    const settings = this.store.get()
    const providerInput: ProviderInput = { ...input, settings }
    const key = keyFor(providerInput, this.store)
    const info = providerInfo(input.provider)
    if (info.requiresKey && !key) throw new Error('لم يتم إعداد مفتاح API لهذا المزود')
    const maxRetries = input.retries ?? 2
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const text = await chatWithProvider({ ...providerInput, ...input }, key)
        if (!text.trim()) throw new Error('وصل رد فارغ من مزود الملخص')
        return text
      } catch (error) {
        lastError = error
        if (attempt === maxRetries) break
        await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /** Drop a local model from VRAM once a summary is finished. */
  async release(input: { provider: ProviderId; baseUrl?: string; model: string }): Promise<void> {
    if (input.provider !== 'ollama' || !input.model) return
    const settings = this.store.get()
    await releaseOllamaModel(baseUrlFor({ ...input, settings }), input.model)
  }
}
