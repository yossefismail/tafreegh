import { describe, expect, it } from 'vitest'
import { ipcErrorMessage } from '../../src/shared/ipcError'

describe('ipcErrorMessage', () => {
  it('strips the Electron transport wrapper around a main-process error', () => {
    const raw = new Error(
      "Error invoking remote method 'setup:download-model': Error: نسخة محرك التفريغ المثبّتة لا تدعم الخيار --variant."
    )
    expect(ipcErrorMessage(raw)).toBe('نسخة محرك التفريغ المثبّتة لا تدعم الخيار --variant.')
  })

  it('leaves a plain message untouched', () => {
    expect(ipcErrorMessage(new Error('لم يتم العثور على معالج NVIDIA'))).toBe(
      'لم يتم العثور على معالج NVIDIA'
    )
  })

  it('handles non-Error rejections and empty input', () => {
    expect(ipcErrorMessage('Error: فشل')).toBe('فشل')
    expect(ipcErrorMessage(undefined)).toBe('حدث خطأ غير متوقع')
    expect(ipcErrorMessage(new Error(''))).toBe('حدث خطأ غير متوقع')
  })

  it('keeps the real message when it itself mentions a channel', () => {
    const raw = new Error(
      "Error invoking remote method 'jobs:start': Error: Error invoking remote method 'x': الملف غير موجود"
    )
    expect(ipcErrorMessage(raw)).toBe('الملف غير موجود')
  })
})
