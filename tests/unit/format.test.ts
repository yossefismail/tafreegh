import { describe, it, expect } from 'vitest'
import {
  formatDuration,
  formatBytes,
  formatClock,
  dateGroup,
  speakerLabel
} from '../../src/renderer/src/lib/format'

describe('formatDuration', () => {
  it('returns 00:00 for missing, zero or sub-half-second values', () => {
    expect(formatDuration()).toBe('00:00')
    expect(formatDuration(0)).toBe('00:00')
    expect(formatDuration(0.4)).toBe('00:00')
  })

  it('formats minutes and seconds', () => {
    expect(formatDuration(1)).toBe('00:01')
    expect(formatDuration(65)).toBe('01:05')
    expect(formatDuration(3599)).toBe('59:59')
  })

  it('adds an hours component when needed', () => {
    expect(formatDuration(3600)).toBe('1:00:00')
    expect(formatDuration(3661)).toBe('1:01:01')
    expect(formatDuration(7325)).toBe('2:02:05')
  })

  it('rounds to the nearest second', () => {
    expect(formatDuration(59.6)).toBe('01:00')
    expect(formatDuration(59.4)).toBe('00:59')
  })
})

describe('formatBytes', () => {
  it('returns 0 MB for missing or non-positive sizes', () => {
    expect(formatBytes()).toBe('0 MB')
    expect(formatBytes(0)).toBe('0 MB')
    expect(formatBytes(-100)).toBe('0 MB')
  })

  it('formats kilobytes', () => {
    expect(formatBytes(250_000)).toBe('250 KB')
  })

  it('formats megabytes with one decimal below 10 MB', () => {
    expect(formatBytes(1_500_000)).toBe('1.5 MB')
    expect(formatBytes(5_000_000)).toBe('5.0 MB')
    expect(formatBytes(15_000_000)).toBe('15 MB')
  })

  it('formats gigabytes', () => {
    expect(formatBytes(1_000_000_000)).toBe('1.00 GB')
    expect(formatBytes(2_500_000_000)).toBe('2.50 GB')
  })
})

describe('formatClock', () => {
  it('formats milliseconds as a clock', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(1_000)).toBe('00:01')
    expect(formatClock(61_000)).toBe('01:01')
    expect(formatClock(3_661_000)).toBe('1:01:01')
  })

  it('clamps negative values to zero', () => {
    expect(formatClock(-500)).toBe('00:00')
  })

  it('floors partial seconds', () => {
    expect(formatClock(1_999)).toBe('00:01')
  })
})

describe('dateGroup', () => {
  const now = new Date()
  const at = (daysAgo: number, hour = 12): string =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour).toISOString()

  it('groups today and future dates as today', () => {
    expect(dateGroup(at(0))).toBe('today')
    expect(dateGroup(at(-1))).toBe('today')
  })

  it('groups the previous calendar day as yesterday', () => {
    expect(dateGroup(at(1))).toBe('yesterday')
  })

  it('groups 2-6 days ago as this week', () => {
    expect(dateGroup(at(2))).toBe('thisWeek')
    expect(dateGroup(at(6))).toBe('thisWeek')
  })

  it('groups a week or more ago as older', () => {
    expect(dateGroup(at(7))).toBe('older')
    expect(dateGroup(at(30))).toBe('older')
  })
})

describe('speakerLabel', () => {
  it('uses Arabic singular, dual and plural forms', () => {
    expect(speakerLabel(1, 'ar')).toBe('متحدث واحد')
    expect(speakerLabel(2, 'ar')).toBe('متحدثان')
    expect(speakerLabel(3, 'ar')).toBe('3 متحدثين')
    expect(speakerLabel(0, 'ar')).toBe('0 متحدثين')
  })

  it('uses English singular and plural forms', () => {
    expect(speakerLabel(1, 'en')).toBe('1 speaker')
    expect(speakerLabel(0, 'en')).toBe('0 speakers')
    expect(speakerLabel(4, 'en')).toBe('4 speakers')
  })
})
