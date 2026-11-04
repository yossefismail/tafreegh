import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => process.cwd(), isPackaged: false }
}))

import { HistoryStore } from '../../src/main/services/history'

const root = mkdtempSync(join(tmpdir(), 'tafreegh-history-'))

beforeAll(() => {
  process.env.TAFREEGH_DATA_DIR = root
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.TAFREEGH_DATA_DIR
})

function writeHistory(items: unknown[]): void {
  writeFileSync(join(root, 'history.json'), JSON.stringify(items), 'utf8')
}

describe('HistoryStore', () => {
  it('backfills fields missing from an older/hand-edited history.json', () => {
    writeHistory([
      {
        id: 'abcdef12',
        createdAt: '2026-01-01T00:00:00.000Z'
        // speakers, language, files, title are all missing
      }
    ])
    const store = new HistoryStore()
    const job = store.get('abcdef12')
    expect(job).toBeDefined()
    expect(job?.speakers).toEqual([])
    expect(job?.language).toBe('ar')
    expect(job?.files).toEqual({})
    expect(job?.title).toBe('تسجيل')
    expect(job?.status).toBe('error')
  })

  it('marks jobs that were running when the app died as interrupted', () => {
    writeHistory([
      {
        id: 'abcdef12',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'running',
        speakers: [],
        files: {}
      }
    ])
    const store = new HistoryStore()
    const job = store.get('abcdef12')
    expect(job?.status).toBe('error')
    expect(job?.error).toContain('توقف التطبيق')
  })

  it('filters non-string speakers instead of passing them through', () => {
    writeHistory([
      {
        id: 'abcdef12',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'done',
        speakers: ['A', null, 3, 'B'],
        files: {}
      }
    ])
    const store = new HistoryStore()
    expect(store.get('abcdef12')?.speakers).toEqual(['A', 'B'])
  })
})
