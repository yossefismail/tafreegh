import { describe, it, expect } from 'vitest'
import {
  AUDIO_EXTENSIONS,
  DIALECTS,
  isAudioPath
} from '../../src/shared/languages'

describe('isAudioPath', () => {
  it('accepts audio and video-container extensions', () => {
    for (const ext of ['m4a', 'mp3', 'wav', 'ogg', 'opus', 'mp4']) {
      expect(isAudioPath(`recording.${ext}`), ext).toBe(true)
      expect(isAudioPath(`C:\\Users\\me\\recordings\\clip.${ext}`), ext).toBe(true)
    }
  })

  it('is case-insensitive', () => {
    expect(isAudioPath('CLIP.MP3')).toBe(true)
    expect(isAudioPath('Clip.M4A')).toBe(true)
  })

  it('rejects non-audio documents', () => {
    expect(isAudioPath('notes.txt')).toBe(false)
    expect(isAudioPath('report.pdf')).toBe(false)
    expect(isAudioPath('setup.exe')).toBe(false)
    expect(isAudioPath('archive.zip')).toBe(false)
  })

  it('accepts every extension listed in AUDIO_EXTENSIONS', () => {
    for (const ext of AUDIO_EXTENSIONS) {
      expect(isAudioPath(`file.${ext}`), ext).toBe(true)
    }
  })
})

describe('DIALECTS', () => {
  it('has unique codes', () => {
    const codes = DIALECTS.map((d) => d.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('includes EG as the default option', () => {
    const eg = DIALECTS.find((d) => d.code === 'EG')
    expect(eg).toBeDefined()
    expect(eg?.en.toLowerCase()).toContain('default')
    expect(eg?.ar).toContain('افتراضي')
    expect(DIALECTS[0].code).toBe('EG')
  })

  it('gives every dialect a non-empty Arabic and English label', () => {
    for (const dialect of DIALECTS) {
      expect(dialect.ar.trim(), dialect.code).not.toBe('')
      expect(dialect.en.trim(), dialect.code).not.toBe('')
    }
  })

  it('exposes the supported Arabic-region dialects', () => {
    const codes = DIALECTS.map((d) => d.code)
    for (const code of ['EG', 'SA', 'AE', 'KW', 'QA', 'JO', 'LB', 'IQ', 'MA']) {
      expect(codes, code).toContain(code)
    }
  })
})
