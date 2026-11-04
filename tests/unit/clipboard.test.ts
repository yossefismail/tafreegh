import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() } }))

import { clipboard } from 'electron'
import { copyTextToClipboard } from '../../src/main/services/clipboard'

describe('copyTextToClipboard', () => {
  it('writes the text through the clipboard', () => {
    copyTextToClipboard('مرحبًا')
    expect(clipboard.writeText).toHaveBeenCalledWith('مرحبًا')
  })

  it('never clears the clipboard for empty text', () => {
    vi.mocked(clipboard.writeText).mockClear()
    copyTextToClipboard('')
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })

  it('fails with an actionable Arabic message when the clipboard is absent', () => {
    expect(() => copyTextToClipboard('x', {} as never)).toThrow('الحافظة')
  })

  it('translates a native clipboard error', () => {
    const writer = {
      writeText: () => {
        throw new Error('OpenClipboard failed')
      }
    }
    expect(() => copyTextToClipboard('x', writer)).toThrow('حدّد النص وانسخه يدويًا')
  })
})
