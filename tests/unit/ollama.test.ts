import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { isLocalBase, modelTag, nativeBase } from '../../src/main/services/ollama'

describe('nativeBase', () => {
  it('drops the OpenAI-compatible suffix and trailing slashes', () => {
    expect(nativeBase('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434')
    expect(nativeBase('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434')
    expect(nativeBase('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434')
    expect(nativeBase('https://ollama.com/v1')).toBe('https://ollama.com')
  })
})

describe('isLocalBase', () => {
  it('recognises loopback only', () => {
    expect(isLocalBase('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isLocalBase('http://localhost:11434/v1')).toBe(true)
    expect(isLocalBase('http://192.168.1.40:11434/v1')).toBe(false)
    expect(isLocalBase('https://ollama.com/v1')).toBe(false)
    expect(isLocalBase('not a url')).toBe(false)
  })
})

describe('modelTag', () => {
  it('normalises bare names the way Ollama does', () => {
    expect(modelTag('gemma4')).toBe('gemma4:latest')
    expect(modelTag('gemma4:e4b')).toBe('gemma4:e4b')
    expect(modelTag('  qwen3:8b  ')).toBe('qwen3:8b')
    expect(modelTag('')).toBe('')
  })
})
