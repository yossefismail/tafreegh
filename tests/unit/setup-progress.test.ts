import { describe, expect, it } from 'vitest'
import { overallSetupPct } from '../../src/shared/setupProgress'
import type { SetupPhase } from '../../src/shared/types'

const ORDER: SetupPhase[] = [
  'check',
  'uv',
  'python',
  'deps',
  'probe',
  'jais',
  'diarizer',
  'done'
]

describe('overallSetupPct', () => {
  it('maps phase-local percentages onto one 0-100 track', () => {
    expect(overallSetupPct('uv', 0)).toBe(2)
    expect(overallSetupPct('uv', 100)).toBe(30)
    expect(overallSetupPct('python', 0)).toBe(30)
    expect(overallSetupPct('done', 100)).toBe(100)
  })

  it('never goes backwards when a phase hands over at 100%', () => {
    for (let i = 1; i < ORDER.length; i += 1) {
      const previousEnd = overallSetupPct(ORDER[i - 1], 100)
      const nextStart = overallSetupPct(ORDER[i], 0)
      expect(nextStart).toBeGreaterThanOrEqual(previousEnd)
      expect(nextStart - previousEnd).toBeLessThanOrEqual(1)
    }
  })

  it('is non-decreasing inside a phase', () => {
    let last = -1
    for (const phase of ORDER) {
      for (let pct = 0; pct <= 100; pct += 5) {
        const value = overallSetupPct(phase, pct)
        expect(value).toBeGreaterThanOrEqual(last)
        last = value
      }
    }
  })

  it('clamps junk input instead of producing NaN', () => {
    expect(overallSetupPct('uv', -50)).toBe(2)
    expect(overallSetupPct('uv', 250)).toBe(30)
    expect(overallSetupPct('uv', Number.NaN)).toBe(2)
    expect(overallSetupPct(undefined, 42)).toBe(42)
  })
})
