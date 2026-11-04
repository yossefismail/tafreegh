import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => join(tmpdir(), 'tafreegh-unused-home')
  }
}))

import {
  JAIS_VARIANTS,
  enginePython,
  jaisComplete,
  jaisIsCustom,
  jaisVariant,
  readMarkerRaw,
  selectJaisVariant,
  setJaisDir
} from '../../src/main/services/engine'
import { getPaths } from '../../src/main/services/paths'
import { SetupService, requiredDiskGb } from '../../src/main/services/setup'

const root = mkdtempSync(join(tmpdir(), 'tafreegh-engine-'))
const previousLocalAppData = process.env.LOCALAPPDATA
const localAppData = join(root, 'localappdata')
const homeDir = join(root, 'home')

beforeAll(() => {
  process.env.TAFREEGH_DATA_DIR = root
  process.env.LOCALAPPDATA = localAppData
  mkdirSync(localAppData, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
})

beforeEach(() => {
  rmSync(getPaths().setup, { force: true })
  rmSync(getPaths().jais, { recursive: true, force: true })
  rmSync(join(root, 'borrow'), { recursive: true, force: true })
  rmSync(join(localAppData, 'NeMoSpeech'), { recursive: true, force: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.TAFREEGH_DATA_DIR
  if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = previousLocalAppData
})

function touch(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
}

describe('JAIS_VARIANTS catalog', () => {
  it('ships only the two GGUF quantizations llama.cpp can run', () => {
    expect(Object.keys(JAIS_VARIANTS).sort()).toEqual(['gguf', 'gguf-q8'])
    for (const spec of Object.values(JAIS_VARIANTS)) {
      expect(spec.repo).toBe('IFM/Jais-ASR-GGUF')
      expect(spec.files).toHaveLength(2)
    }
    expect(JAIS_VARIANTS.gguf.label).toContain('Q4_K_M')
    expect(JAIS_VARIANTS['gguf-q8'].label).toContain('Q8_0')
    expect(JAIS_VARIANTS['gguf-q8'].vramGb).toBeGreaterThan(JAIS_VARIANTS.gguf.vramGb)
  })
})

describe('selectJaisVariant', () => {
  afterEach(() => {
    delete process.env.TAFREEGH_JAIS_VARIANT
  })

  it('picks Q4_K_M without a GPU or with a 6 GB card', () => {
    expect(selectJaisVariant(0)).toBe('gguf')
    expect(selectJaisVariant(undefined)).toBe('gguf')
    expect(selectJaisVariant(6 * 1024)).toBe('gguf')
  })

  it('switches to Q8_0 from 9 GB of VRAM', () => {
    expect(selectJaisVariant(9 * 1024)).toBe('gguf-q8')
    expect(selectJaisVariant(24 * 1024)).toBe('gguf-q8')
  })

  it('honors TAFREEGH_JAIS_VARIANT only for catalog entries', () => {
    process.env.TAFREEGH_JAIS_VARIANT = 'gguf-q8'
    expect(selectJaisVariant(0)).toBe('gguf-q8')
    process.env.TAFREEGH_JAIS_VARIANT = 'gguf'
    expect(selectJaisVariant(24 * 1024)).toBe('gguf')
    process.env.TAFREEGH_JAIS_VARIANT = 'fp8'
    expect(selectJaisVariant(24 * 1024)).toBe('gguf-q8')
    expect(selectJaisVariant(0)).toBe('gguf')
    process.env.TAFREEGH_JAIS_VARIANT = 'toString'
    expect(selectJaisVariant(0)).toBe('gguf')
  })
})

describe('requiredDiskGb', () => {
  it('keeps a small floor when there is nothing to download', () => {
    // Nothing to fetch: must not demand 5 GB from an almost-full disk.
    expect(requiredDiskGb('gguf', false, false)).toBe(2)
    expect(requiredDiskGb('gguf-q8', false, false)).toBe(2)
  })

  it('adds the selected artifact size, not the currently installed one', () => {
    const gguf = Math.ceil(JAIS_VARIANTS.gguf.bytes / 1e9)
    expect(requiredDiskGb('gguf', false, true)).toBe(Math.max(5, gguf + 2))
  })

  it('asks for more space when Q8_0 is the recommended quant', () => {
    const q8 = Math.ceil(JAIS_VARIANTS['gguf-q8'].bytes / 1e9)
    expect(q8).toBeGreaterThan(Math.ceil(JAIS_VARIANTS.gguf.bytes / 1e9))
    expect(requiredDiskGb('gguf-q8', false, true)).toBe(q8 + 2)
  })

  it('includes the runtime when the venv is missing', () => {
    const q8 = Math.ceil(JAIS_VARIANTS['gguf-q8'].bytes / 1e9)
    expect(requiredDiskGb('gguf-q8', true, true)).toBe(7 + q8 + 2)
    expect(requiredDiskGb('gguf', true, false)).toBe(7 + 2)
  })
})

describe('enginePython', () => {
  it('falls back to the managed venv when a borrowed interpreter is gone', () => {
    writeFileSync(
      getPaths().setup,
      JSON.stringify({
        completed: true,
        updatedAt: new Date().toISOString(),
        mode: 'existing',
        python: join(root, 'uninstalled', 'python.exe')
      }),
      'utf8'
    )
    expect(enginePython()).toBe(getPaths().python)
  })

  it('uses the borrowed interpreter while it still exists', () => {
    const borrowed = join(root, 'custom-python', 'python.exe')
    touch(borrowed)
    writeFileSync(
      getPaths().setup,
      JSON.stringify({
        completed: true,
        updatedAt: new Date().toISOString(),
        mode: 'existing',
        python: borrowed
      }),
      'utf8'
    )
    expect(enginePython()).toBe(borrowed)
  })
})

describe('setJaisDir', () => {
  it('does not create a marker just to clear a value that was never set', () => {
    setJaisDir(undefined)
    expect(existsSync(getPaths().setup)).toBe(false)
  })

  it('records and clears the borrowed folder', () => {
    const borrowed = join(root, 'borrow')
    mkdirSync(borrowed, { recursive: true })
    setJaisDir(borrowed)
    expect(jaisIsCustom()).toBe(true)
    expect(readMarkerRaw()?.jaisDir).toBe(borrowed)
    setJaisDir(undefined)
    expect(jaisIsCustom()).toBe(false)
  })
})

describe('jaisVariant', () => {
  it('prefers the Q4_K_M file when several quants share the folder, like the worker', () => {
    const dir = join(root, 'multi-gguf')
    mkdirSync(dir, { recursive: true })
    touch(join(dir, 'Jais-ASR-Q4_K_M.gguf'))
    touch(join(dir, 'Jais-ASR-Q8_0.gguf'))
    touch(join(dir, 'mmproj-Jais-ASR-Q6_K.gguf'))
    expect(jaisComplete(dir)).toBe(true)
    expect(jaisVariant(dir)).toBe('gguf')
  })

  it('detects a Q8_0-only GGUF folder', () => {
    const dir = join(root, 'q8-gguf')
    mkdirSync(dir, { recursive: true })
    touch(join(dir, 'Jais-ASR-Q8_0.gguf'))
    touch(join(dir, 'mmproj-Jais-ASR-F16.gguf'))
    expect(jaisVariant(dir)).toBe('gguf-q8')
  })

  it('ignores a safetensors-era folder without a GGUF pair', () => {
    const dir = join(root, 'safetensors')
    mkdirSync(dir, { recursive: true })
    touch(join(dir, 'config.json'))
    touch(join(dir, 'model.safetensors'))
    expect(jaisComplete(dir)).toBe(false)
    expect(jaisVariant(dir)).toBeNull()
  })
})

describe('SetupService.removeModels', () => {
  function seed(): void {
    touch(join(getPaths().jais, 'config.json'))
    touch(join(localAppData, 'NeMoSpeech', 'models', 'diarizer.bin'))
    writeFileSync(
      getPaths().setup,
      JSON.stringify({
        completed: true,
        updatedAt: new Date().toISOString(),
        mode: 'existing',
        python: typeof process.execPath === 'string' ? process.execPath : undefined,
        jaisDir: join(root, 'borrow')
      }),
      'utf8'
    )
    mkdirSync(join(root, 'borrow'), { recursive: true })
    writeFileSync(join(root, 'borrow', 'config.json'), '{}', 'utf8')
  }

  it('still removes the app-owned Jais copy in a borrowed setup', async () => {
    seed()
    const service = new SetupService(() => undefined)
    await service.removeModels()
    expect(existsSync(getPaths().jais)).toBe(false)
    expect(existsSync(join(root, 'borrow', 'config.json'))).toBe(true)
    expect(existsSync(getPaths().setup)).toBe(false)
  })

  it('leaves a shared NeMo cache alone while borrowing a setup', async () => {
    seed()
    const service = new SetupService(() => undefined)
    await service.removeModels()
    expect(existsSync(join(localAppData, 'NeMoSpeech', 'models'))).toBe(true)
  })

  it('removes the NeMo cache for a fully managed setup', async () => {
    seed()
    const marker = JSON.parse(readFileSync(getPaths().setup, 'utf8')) as Record<string, unknown>
    writeFileSync(getPaths().setup, JSON.stringify({ ...marker, mode: 'managed' }), 'utf8')
    const service = new SetupService(() => undefined)
    await service.removeModels()
    expect(existsSync(join(localAppData, 'NeMoSpeech', 'models'))).toBe(false)
  })
})
