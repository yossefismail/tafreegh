import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { net } from 'electron'
import { downloadFile } from '../../src/main/services/download'

const root = mkdtempSync(join(tmpdir(), 'tafreegh-download-'))
const fetchMock = vi.mocked(net.fetch)

function response(body: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers })
}

beforeEach(() => {
  fetchMock.mockReset()
  rmSync(join(root, 'model.bin'), { force: true })
  rmSync(join(root, 'model.bin.part'), { force: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('downloadFile', () => {
  it('writes the complete body and removes the partial file', async () => {
    fetchMock.mockResolvedValue(
      response(new Uint8Array([1, 2, 3, 4]), { 'content-length': '4' }) as never
    )
    const seen: number[] = []
    await downloadFile('https://example.test/model.bin', join(root, 'model.bin'), (progress) =>
      seen.push(progress.received)
    )
    expect(existsSync(join(root, 'model.bin'))).toBe(true)
    expect(readFileSync(join(root, 'model.bin'))).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(existsSync(join(root, 'model.bin.part'))).toBe(false)
    expect(seen.at(-1)).toBe(4)
  })

  it('rejects a body shorter than content-length and cleans up', async () => {
    fetchMock.mockResolvedValue(
      response(new Uint8Array([1, 2, 3]), { 'content-length': '10' }) as never
    )
    await expect(
      downloadFile('https://example.test/model.bin', join(root, 'model.bin'))
    ).rejects.toThrow(/incomplete/)
    expect(existsSync(join(root, 'model.bin'))).toBe(false)
    expect(existsSync(join(root, 'model.bin.part'))).toBe(false)
  })

  it('skips the network when the destination is already complete', async () => {
    writeFileSync(join(root, 'model.bin'), 'already-here')
    await downloadFile('https://example.test/model.bin', join(root, 'model.bin'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not start a request for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      downloadFile(
        'https://example.test/model.bin',
        join(root, 'model.bin'),
        undefined,
        controller.signal
      )
    ).rejects.toThrow('أُلغي التنزيل')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a failed HTTP status without leaving a partial file', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }) as never)
    await expect(
      downloadFile('https://example.test/model.bin', join(root, 'model.bin'))
    ).rejects.toThrow(/503/)
    expect(existsSync(join(root, 'model.bin.part'))).toBe(false)
  })
})
