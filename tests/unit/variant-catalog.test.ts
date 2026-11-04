import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/tmp' }
}))

import { JAIS_VARIANTS } from '../../src/main/services/engine'

interface PythonVariant {
  repo?: string
  label?: string
  bytes?: number
  wer?: number
  vramGb?: number
  files?: string[]
}

/**
 * The backend owns the catalog (`JAIS_VARIANTS` in pipeline.py) and the main
 * process mirrors it for the wizard. Download `--variant` values, labels and
 * byte counts must agree or the UI promises something the worker refuses.
 */
function readPythonCatalog(): Record<string, PythonVariant> {
  const source = readFileSync(join(process.cwd(), 'backend', 'tafreegh', 'pipeline.py'), 'utf8')
  const anchor = source.indexOf('JAIS_VARIANTS = {')
  if (anchor < 0) throw new Error('JAIS_VARIANTS not found in backend/tafreegh/pipeline.py')

  const entries: Record<string, string> = {}
  let depth = 0
  let key: string | null = null
  let bodyStart = -1
  let index = source.indexOf('{', anchor)
  for (; index < source.length; index++) {
    const char = source[index]
    if (char === '"' && depth === 1) {
      const match = /^"([\w-]+)"\s*:\s*\{/.exec(source.slice(index))
      if (match) {
        key = match[1]
        bodyStart = index + match[0].length
        depth++
        index = bodyStart - 1
        continue
      }
    }
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 1 && key && bodyStart >= 0) {
        entries[key] = source.slice(bodyStart, index)
        key = null
        bodyStart = -1
      }
      if (depth === 0) break
    }
  }

  const parsed: Record<string, PythonVariant> = {}
  for (const [id, body] of Object.entries(entries)) {
    const text = (name: string): string | undefined =>
      body.match(new RegExp(`"${name}":\\s*"([^"]*)"`))?.[1]
    const number = (name: string): number | undefined => {
      const raw = body.match(new RegExp(`"${name}":\\s*([\\d_.]+)`))?.[1]
      return raw === undefined ? undefined : Number(raw.replace(/_/g, ''))
    }
    const files = body
      .match(/"files":\s*\[([^\]]*)\]/)?.[1]
      .match(/"([^"]+)"/g)
      ?.map((name) => name.slice(1, -1))
    parsed[id] = {
      repo: text('repo'),
      label: text('label'),
      bytes: number('bytes'),
      wer: number('wer'),
      vramGb: number('vramGb'),
      files
    }
  }
  return parsed
}

describe('Jais variant catalog', () => {
  const python = readPythonCatalog()

  it('defines exactly the same variants as the worker', () => {
    expect(Object.keys(python).sort()).toEqual(Object.keys(JAIS_VARIANTS).sort())
  })

  it.each(Object.keys(JAIS_VARIANTS) as Array<keyof typeof JAIS_VARIANTS>)(
    'keeps %s in sync with backend/tafreegh/pipeline.py',
    (id) => {
      const backend = python[id]
      expect(backend, `variant ${id} is missing from pipeline.py`).toBeDefined()
      const frontend = JAIS_VARIANTS[id]
      expect(frontend.repo).toBe(backend.repo)
      expect(frontend.label).toBe(backend.label)
      expect(frontend.bytes).toBe(backend.bytes)
      expect(frontend.wer).toBe(backend.wer)
      expect(frontend.vramGb).toBe(backend.vramGb)
      expect(frontend.files ?? []).toEqual(backend.files ?? [])
    }
  )
})
