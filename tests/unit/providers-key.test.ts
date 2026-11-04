import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { keyFor, type ProviderInput } from '../../src/main/services/providers'
import type { Settings } from '../../src/shared/types'

const STORED = 'sk-stored-secret'

function input(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    provider: 'openai',
    settings: {
      providers: { openai: { baseUrl: 'https://my-proxy.example/v1' } },
      summarizer: { provider: 'none', model: '' }
    } as unknown as Settings,
    ...overrides
  }
}

const store = { getApiKey: () => STORED } as never

describe('keyFor', () => {
  it('prefers a key typed in the request', () => {
    expect(keyFor(input({ apiKey: ' sk-typed ' }), store)).toBe('sk-typed')
  })

  it('releases the stored key when no URL is supplied', () => {
    expect(keyFor(input(), store)).toBe(STORED)
  })

  it('releases the stored key for the provider default URL', () => {
    expect(keyFor(input({ baseUrl: 'https://api.openai.com/v1/' }), store)).toBe(STORED)
  })

  it('releases the stored key for the URL it was saved with', () => {
    expect(keyFor(input({ baseUrl: 'https://my-proxy.example/v1' }), store)).toBe(STORED)
  })

  it('never sends the stored key to a renderer-chosen host', () => {
    expect(keyFor(input({ baseUrl: 'https://attacker.example/v1' }), store)).toBeUndefined()
  })
})
