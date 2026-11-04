import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPaths } from './paths'

/**
 * User-chosen model locations. Jais-ASR keeps its folder in the engine marker
 * (that is what `mode: existing` means); the diarizer has no such marker, so
 * its path lives here.
 */
export interface ModelOverrides {
  diarizerModel?: string
}

function file(): string {
  return join(getPaths().root, 'models.json')
}

export function readOverrides(): ModelOverrides {
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as ModelOverrides
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed
  } catch {
    return {}
  }
}

export function writeOverrides(patch: Partial<ModelOverrides>): ModelOverrides {
  const next = { ...readOverrides(), ...patch }
  for (const key of Object.keys(next) as Array<keyof ModelOverrides>) {
    if (!next[key]) delete next[key]
  }
  writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

/** A single .gguf file the user picked, or '' for the nemo-speech cache. */
export function diarizerModel(): string {
  return readOverrides().diarizerModel ?? ''
}

export function clearOverride(kind: 'diarizer'): void {
  if (kind === 'diarizer') writeOverrides({ diarizerModel: undefined })
}

export function realPath(path: string): string | null {
  return path && existsSync(path) ? path : null
}
