import { describe, expect, it } from 'vitest'
import { isWithinRoot } from '../../src/main/services/paths'

describe('isWithinRoot', () => {
  const root = 'C:\\Users\\demo\\AppData\\Local\\Tafreegh'

  it('accepts the root and paths below it', () => {
    expect(isWithinRoot(root, root)).toBe(true)
    expect(isWithinRoot(root, `${root}\\jobs\\abc\\transcript.html`)).toBe(true)
  })

  it('rejects traversal and sibling folders that share a prefix', () => {
    expect(isWithinRoot(root, `${root}\\..\\secrets.json`)).toBe(false)
    expect(isWithinRoot(root, `${root}-evil\\payload.html`)).toBe(false)
    expect(isWithinRoot(root, 'C:\\Windows\\System32\\cmd.exe')).toBe(false)
  })

  it('compares Windows paths case-insensitively', () => {
    expect(isWithinRoot(root, root.toLowerCase() + '\\jobs')).toBe(true)
  })

  it('handles missing input', () => {
    expect(isWithinRoot('', `${root}\\a`)).toBe(false)
    expect(isWithinRoot(root, '')).toBe(false)
  })
})
