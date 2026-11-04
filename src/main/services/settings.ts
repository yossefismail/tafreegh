import { safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ProviderId, Settings, SummarizerSettings } from '../../shared/types'
import { getPaths, MOCK } from './paths'

const DEFAULTS: Settings = {
  language: 'ar',
  dialect: 'EG',
  enhance: true,
  summarizer: {
    provider: 'ollama',
    model: MOCK ? 'qwen3:14b' : 'gemma4:e4b',
    baseUrl: '',
    temperature: 0.2,
    maxTokens: 2500
  },
  providers: {}
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * The Hugging Face token lives in the same encrypted secret map as API keys,
 * under a name no ProviderId can ever equal.
 */
const HF_TOKEN_SECRET = '@huggingface'

/** Notepad and PowerShell may save JSON with a UTF-8 BOM. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export class SettingsStore {
  private settings: Settings = clone(DEFAULTS)
  private secrets: Record<string, string> = {}
  private secure = true

  constructor() {
    this.load()
    this.loadSecrets()
  }

  private load(): void {
    const file = getPaths().settings
    if (!existsSync(file)) return
    try {
      const parsed = JSON.parse(stripBom(readFileSync(file, 'utf8'))) as Partial<Settings>
      this.settings = {
        ...clone(DEFAULTS),
        ...parsed,
        summarizer: { ...clone(DEFAULTS.summarizer), ...(parsed.summarizer ?? {}) },
        providers: { ...(parsed.providers ?? {}) }
      }
      // The safetensors builds stored a user-visible `quant` level. It no
      // longer exists (GGUF-only), so a legacy file must not carry it forward.
      delete (this.settings as Settings & { quant?: unknown }).quant
      // Derived from the secret store, never persisted in settings.json.
      delete this.settings.hfTokenSet
    } catch {
      this.settings = clone(DEFAULTS)
    }
  }

  private loadSecrets(): void {
    const file = getPaths().secrets
    if (!existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        secure?: boolean
        values?: Record<string, string>
      }
      this.secure = parsed.secure !== false
      this.secrets = parsed.values ?? {}
    } catch {
      this.secrets = {}
    }
  }

  private persist(): void {
    const file = getPaths().settings
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.settings, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  private persistSecrets(): void {
    const file = getPaths().secrets
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify({ secure: this.secure, values: this.secrets }, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  get(): Settings {
    const copy = clone(this.settings)
    for (const id of Object.keys(copy.providers) as ProviderId[]) {
      const entry = copy.providers[id]
      if (entry) entry.apiKeySet = Boolean(this.secrets[id])
    }
    copy.hfTokenSet = Boolean(this.secrets[HF_TOKEN_SECRET])
    return copy
  }

  update(patch: Partial<Settings>): Settings {
    const next = clone(this.settings)
    if (patch.language === 'ar' || patch.language === 'en') next.language = patch.language
    if (typeof patch.dialect === 'string') next.dialect = patch.dialect
    if (typeof patch.enhance === 'boolean') next.enhance = patch.enhance
    if (patch.summarizer) {
      const s = patch.summarizer as SummarizerSettings
      next.summarizer = {
        ...next.summarizer,
        provider: s.provider ?? next.summarizer.provider,
        model: s.model ?? next.summarizer.model,
        baseUrl: s.baseUrl ?? next.summarizer.baseUrl,
        temperature:
          typeof s.temperature === 'number'
            ? Math.max(0, Math.min(1.5, s.temperature))
            : next.summarizer.temperature,
        maxTokens:
          typeof s.maxTokens === 'number'
            ? Math.max(256, Math.min(16000, Math.round(s.maxTokens)))
            : next.summarizer.maxTokens
      }
    }
    if (patch.providers) {
      // Merge per provider: the renderer often sends only the field the user
      // edited (baseUrl *or* model), and replacing the entry dropped the other.
      const providers = { ...next.providers }
      for (const [id, entry] of Object.entries(patch.providers)) {
        if (!entry) continue
        const key = id as ProviderId
        providers[key] = { ...providers[key], ...entry }
      }
      next.providers = providers
    }
    // Renderer round-trips of `get()` must never write the derived flag into
    // settings.json (and the strict IPC schema rejects it).
    delete next.hfTokenSet
    this.settings = next
    this.persist()
    return this.get()
  }

  private writeSecret(slot: string, value: string): void {
    if (safeStorage.isEncryptionAvailable()) {
      this.secure = true
      this.secrets[slot] = safeStorage.encryptString(value).toString('base64')
    } else {
      this.secure = false
      this.secrets[slot] = 'plain:' + Buffer.from(value, 'utf8').toString('base64')
    }
  }

  private readSecret(slot: string): string | undefined {
    const stored = this.secrets[slot]
    if (!stored) return undefined
    try {
      if (stored.startsWith('plain:')) {
        return Buffer.from(stored.slice(6), 'base64').toString('utf8')
      }
      if (!safeStorage.isEncryptionAvailable()) return undefined
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return undefined
    }
  }

  setApiKey(provider: ProviderId, key: string): Settings {
    const trimmed = key.trim()
    if (!trimmed) {
      delete this.secrets[provider]
    } else {
      this.writeSecret(provider, trimmed)
    }
    this.persistSecrets()
    return this.get()
  }

  clearApiKey(provider: ProviderId): Settings {
    delete this.secrets[provider]
    this.persistSecrets()
    return this.get()
  }

  hasApiKey(provider: ProviderId): boolean {
    return Boolean(this.secrets[provider])
  }

  getApiKey(provider: ProviderId): string | undefined {
    return this.readSecret(provider)
  }

  /** Optional Hugging Face token: lifts the anonymous download rate limit. */
  setHfToken(token: string): Settings {
    const trimmed = token.trim()
    if (!trimmed) {
      delete this.secrets[HF_TOKEN_SECRET]
    } else {
      this.writeSecret(HF_TOKEN_SECRET, trimmed)
    }
    this.persistSecrets()
    return this.get()
  }

  clearHfToken(): Settings {
    delete this.secrets[HF_TOKEN_SECRET]
    this.persistSecrets()
    return this.get()
  }

  hasHfToken(): boolean {
    return Boolean(this.secrets[HF_TOKEN_SECRET])
  }

  getHfToken(): string | undefined {
    return this.readSecret(HF_TOKEN_SECRET)
  }

  isSecure(): boolean {
    return this.secure
  }
}
