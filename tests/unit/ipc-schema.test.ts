import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir() },
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() },
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [],
    fromWebContents: vi.fn()
  }
}))

import { settingsPatchSchema, startSchema } from '../../src/main/ipc'

describe('settingsPatchSchema', () => {
  it('rejects the retired quant level instead of silently accepting it', () => {
    expect(settingsPatchSchema.safeParse({ quant: '8bit' }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ quant: 'auto' }).success).toBe(false)
  })

  it('still accepts the settings the UI actually patches', () => {
    const result = settingsPatchSchema.safeParse({ enhance: false, dialect: 'SA' })
    expect(result.success).toBe(true)
  })
})

describe('startSchema', () => {
  it('rejects a quant field on a new job', () => {
    const job = { filePath: 'C:/audio/talk.m4a', language: 'EG', enhance: true }
    expect(startSchema.safeParse(job).success).toBe(true)
    expect(startSchema.safeParse({ ...job, quant: '4bit' }).success).toBe(false)
  })
})
