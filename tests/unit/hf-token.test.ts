import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const DATA_DIR = join(tmpdir(), `tafreegh-hftoken-${process.pid}`)

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  net: { fetch: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^enc:/, '')
  }
}))

import { net } from 'electron'
import { hfTokenEnv, verifyHfToken } from '../../src/main/services/hf'
import { SettingsStore } from '../../src/main/services/settings'

const fetchMock = vi.mocked(net.fetch)

function reply(status: number, body: unknown = {}): void {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as never)
}

describe('hfTokenEnv', () => {
  it('is empty without a token, so downloads stay anonymous', () => {
    expect(hfTokenEnv(undefined)).toEqual({})
    expect(hfTokenEnv('')).toEqual({})
    expect(hfTokenEnv('   ')).toEqual({})
  })

  it('sets both names huggingface_hub reads and trims the value', () => {
    expect(hfTokenEnv('  hf_abc  ')).toEqual({
      HF_TOKEN: 'hf_abc',
      HUGGING_FACE_HUB_TOKEN: 'hf_abc'
    })
  })
})

describe('verifyHfToken', () => {
  beforeAll(() => fetchMock.mockReset())

  it('accepts a token the Hub knows', async () => {
    reply(200, { name: 'youss' })
    await expect(verifyHfToken('hf_good')).resolves.toMatchObject({ status: 'ok', user: 'youss' })
  })

  it('rejects a token the Hub refuses', async () => {
    reply(401)
    await expect(verifyHfToken('hf_bad')).resolves.toEqual({ status: 'invalid' })
    reply(403)
    await expect(verifyHfToken('hf_bad')).resolves.toEqual({ status: 'invalid' })
  })

  it('never rejects a token just because the check could not run', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND huggingface.co'))
    const check = await verifyHfToken('hf_unknown')
    expect(check.status).toBe('unknown')
    reply(503)
    await expect(verifyHfToken('hf_unknown')).resolves.toMatchObject({ status: 'unknown' })
  })
})

describe('SettingsStore Hugging Face token', () => {
  let store: SettingsStore

  beforeAll(() => {
    mkdirSync(DATA_DIR, { recursive: true })
    process.env.TAFREEGH_DATA_DIR = DATA_DIR
    store = new SettingsStore()
  })

  afterAll(() => {
    delete process.env.TAFREEGH_DATA_DIR
    rmSync(DATA_DIR, { recursive: true, force: true })
  })

  it('round-trips the token and exposes only a flag', () => {
    store.setHfToken(' hf_secret_value ')
    expect(store.getHfToken()).toBe('hf_secret_value')
    expect(store.hasHfToken()).toBe(true)
    const settings = store.get()
    expect(settings.hfTokenSet).toBe(true)
    expect(JSON.stringify(settings)).not.toContain('hf_secret_value')
  })

  it('keeps the token out of settings.json and encrypts it in secrets.json', () => {
    const settingsFile = join(DATA_DIR, 'settings.json')
    const secretsFile = join(DATA_DIR, 'secrets.json')
    expect(existsSync(settingsFile)).toBe(false)
    store.update({ language: 'en' })
    expect(readFileSync(settingsFile, 'utf8')).not.toContain('hf_secret_value')
    expect(readFileSync(settingsFile, 'utf8')).not.toContain('hfTokenSet')
    const secrets = readFileSync(secretsFile, 'utf8')
    expect(secrets).not.toContain('hf_secret_value')
    expect(secrets).toContain('@huggingface')
  })

  it('clears the token', () => {
    store.clearHfToken()
    expect(store.getHfToken()).toBeUndefined()
    expect(store.get().hfTokenSet).toBe(false)
  })

  it('drops an empty token instead of storing it', () => {
    store.setHfToken('   ')
    expect(store.hasHfToken()).toBe(false)
  })
})
