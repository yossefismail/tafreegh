import { describe, it, expect } from 'vitest'
import { ar, en, dictionaries, translate } from '../../src/renderer/src/i18n'

const arKeys = Object.keys(ar) as Array<keyof typeof ar>
const enKeys = Object.keys(en) as Array<keyof typeof ar>

describe('i18n dictionaries', () => {
  it('ar and en expose exactly the same keys', () => {
    expect(new Set(enKeys)).toEqual(new Set(arKeys))
    expect(enKeys).toHaveLength(arKeys.length)
  })

  it('has no empty Arabic or English strings', () => {
    for (const key of arKeys) {
      expect(ar[key], `ar.${key}`).toBeTypeOf('string')
      expect(ar[key].trim(), `ar.${key}`).not.toBe('')
      expect(en[key], `en.${key}`).toBeTypeOf('string')
      expect(en[key].trim(), `en.${key}`).not.toBe('')
    }
  })

  it('resolves every key through translate for both languages', () => {
    for (const key of arKeys) {
      expect(translate('ar', key), `translate(ar, ${key})`).toBe(ar[key])
      expect(translate('en', key), `translate(en, ${key})`).toBe(en[key])
      expect(translate('ar', key)).not.toBe('')
      expect(translate('en', key)).not.toBe('')
    }
  })

  it('exposes both languages on the dictionaries map', () => {
    expect(Object.keys(dictionaries).sort()).toEqual(['ar', 'en'])
    expect(dictionaries.ar.appName).toBe('تفريغ')
    expect(dictionaries.en.appName).toBe('Tafreegh')
  })
})
