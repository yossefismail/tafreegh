import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => join(tmpdir(), 'tafreegh-unused-home')
  }
}))

vi.mock('../../src/main/services/worker', () => ({
  CancelledError: class CancelledError extends Error {
    constructor() {
      super('أُلغي التنفيذ')
      this.name = 'CancelledError'
    }
  },
  runWorker: vi.fn()
}))

import { readOverrides, writeOverrides } from '../../src/main/services/models'
import { getPaths } from '../../src/main/services/paths'
import { SetupService } from '../../src/main/services/setup'
import { runWorker } from '../../src/main/services/worker'

const root = mkdtempSync(join(tmpdir(), 'tafreegh-setup-download-'))
const workerMock = vi.mocked(runWorker)

beforeAll(() => {
  process.env.TAFREEGH_DATA_DIR = root
  const python = join(
    root,
    'runtime',
    'venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python'
  )
  mkdirSync(dirname(python), { recursive: true })
  writeFileSync(python, '')
})

beforeEach(() => {
  workerMock.mockReset()
  rmSync(join(root, 'models.json'), { force: true })
})

afterEach(() => {
  delete process.env.TAFREEGH_JAIS_VARIANT
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.TAFREEGH_DATA_DIR
})

describe('SetupService.downloadModel', () => {
  it('restores the borrowed model path when the download fails', async () => {
    const custom = join(root, 'my-diarizer.gguf')
    writeOverrides({ diarizerModel: custom })
    workerMock.mockRejectedValue(new Error('network down'))

    const service = new SetupService(() => undefined)
    await expect(service.downloadModel('diarizer')).rejects.toThrow('network down')
    expect(readOverrides().diarizerModel).toBe(custom)
  })

  it('restores the borrowed folder after a cancelled download', async () => {
    const custom = join(root, 'my-diarizer-2.gguf')
    writeOverrides({ diarizerModel: custom })
    workerMock.mockRejectedValue(new Error('أُلغي التنفيذ'))

    const service = new SetupService(() => undefined)
    await expect(service.downloadModel('diarizer')).rejects.toThrow('أُلغي التنفيذ')
    expect(readOverrides().diarizerModel).toBe(custom)
  })

  it('leaves the override cleared while the download is running', async () => {
    const custom = join(root, 'my-diarizer-3.gguf')
    writeOverrides({ diarizerModel: custom })
    let duringDownload: string | undefined
    workerMock.mockImplementation(async () => {
      duringDownload = readOverrides().diarizerModel
      throw new Error('stop here')
    })

    const service = new SetupService(() => undefined)
    await expect(service.downloadModel('diarizer')).rejects.toThrow('stop here')
    expect(duringDownload).toBeUndefined()
    expect(getPaths().root).toBe(root)
  })

  it('asks the worker for the GGUF quant selected for this device', async () => {
    process.env.TAFREEGH_JAIS_VARIANT = 'gguf-q8'
    workerMock.mockRejectedValue(new Error('stop here'))

    const service = new SetupService(() => undefined)
    await expect(service.downloadModel('jais')).rejects.toThrow('stop here')
    const args = workerMock.mock.calls[0][0].args
    expect(args[0]).toBe('setup-jais')
    expect(args[args.indexOf('--variant') + 1]).toBe('gguf-q8')
    expect(args.join(' ')).not.toContain('--quant')
  })
})
