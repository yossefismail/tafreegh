import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { SettingsStore } from '../../src/main/services/settings'
import type { Settings } from '../../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'tafreegh-settings-'))

beforeAll(() => {
  process.env.TAFREEGH_DATA_DIR = root
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.TAFREEGH_DATA_DIR
})

describe('SettingsStore', () => {
  it('merges a provider patch instead of replacing the whole entry', () => {
    const store = new SettingsStore()
    store.update({ providers: { openai: { baseUrl: 'https://proxy.local/v1' } } })
    store.update({ providers: { openai: { model: 'gpt-5.1' } } })
    const openai = store.get().providers.openai
    expect(openai?.baseUrl).toBe('https://proxy.local/v1')
    expect(openai?.model).toBe('gpt-5.1')
  })

  it('keeps other providers untouched when one is patched', () => {
    const store = new SettingsStore()
    store.update({ providers: { groq: { model: 'qwen/qwen3-32b' } } })
    store.update({ providers: { openai: { model: 'gpt-4.1' } } })
    expect(store.get().providers.groq?.model).toBe('qwen/qwen3-32b')
  })

  it('round-trips an API key through encrypted storage', () => {
    const store = new SettingsStore()
    store.setApiKey('groq', '  gsk-secret-value  ')
    expect(store.hasApiKey('groq')).toBe(true)
    expect(store.getApiKey('groq')).toBe('gsk-secret-value')
    expect(store.get().providers.groq?.apiKeySet).toBe(true)
    store.clearApiKey('groq')
    expect(store.getApiKey('groq')).toBeUndefined()
  })

  it('reads a settings file saved with a UTF-8 BOM', () => {
    writeFileSync(
      join(root, 'settings.json'),
      '\ufeff' + JSON.stringify({ language: 'en', enhance: false }),
      'utf8'
    )
    const store = new SettingsStore()
    expect(store.get().language).toBe('en')
    expect(store.get().enhance).toBe(false)
  })

  it('drops the removed quant level when loading a legacy settings file', () => {
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({ language: 'en', enhance: true, quant: '8bit' }),
      'utf8'
    )
    const store = new SettingsStore()
    expect('quant' in store.get()).toBe(false)
    store.update({ enhance: false })
    const saved = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(saved.quant).toBeUndefined()
    expect(saved.language).toBe('en')
  })

  it('does not accept or persist a quant patch any more', () => {
    const store = new SettingsStore()
    const next = store.update({ quant: '4bit' } as unknown as Partial<Settings>)
    expect('quant' in next).toBe(false)
    expect('quant' in store.get()).toBe(false)
  })
})
