import { describe, it, expect, vi, afterEach } from 'vitest'
import type { JobTranscript, JobTranscriptLine } from '../../src/shared/types'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import {
  cleanSummary,
  deriveMoments,
  transcriptToText,
  summarizeTranscript
} from '../../src/main/services/summarize'

function line(start: number, text: string, speaker = 'سارة'): JobTranscriptLine {
  return { start, end: start + 5, text, speaker }
}

function transcript(
  lines: JobTranscriptLine[],
  overrides: Partial<JobTranscript> = {}
): JobTranscript {
  return {
    duration: 600,
    speechStart: 0,
    speechEnd: 600,
    language: 'ar',
    model: 'jais',
    speakers: ['سارة', 'أحمد'],
    windows: 1,
    lines,
    turns: [],
    ...overrides
  }
}

describe('cleanSummary', () => {
  it('strips markdown code fences', () => {
    expect(cleanSummary('```markdown\n**نظرة عامة:** نص\n```')).toBe('**نظرة عامة:** نص')
    expect(cleanSummary('```\nنص الملخص\n```')).toBe('نص الملخص')
  })

  it('strips leading Arabic filler phrases', () => {
    expect(cleanSummary('بالتأكيد، هذا ملخص.')).toBe('هذا ملخص.')
    expect(cleanSummary('حسنًا! النقاط:')).toBe('النقاط:')
    expect(cleanSummary('حسنا. النقاط:')).toBe('النقاط:')
    expect(cleanSummary('إليك الملخص:\n\nنص')).toBe('نص')
    expect(cleanSummary('إليك ملخص الاجتماع\nنص')).toBe('نص')
    expect(cleanSummary('إليك هذه الملاحظات')).toBe('إليك هذه الملاحظات')
  })

  it('normalizes CRLF and collapses runs of blank lines', () => {
    expect(cleanSummary('أ\r\n\r\n\r\n\r\nب')).toBe('أ\n\nب')
    expect(cleanSummary('  نص  ')).toBe('نص')
  })

  it('leaves an already clean summary unchanged', () => {
    const text = '**نظرة عامة:** اجتماع.\n\n- نقطة (00:10).'
    expect(cleanSummary(text)).toBe(text)
  })
})

describe('deriveMoments', () => {
  it('extracts (mm:ss–mm:ss) headings and drops overview/action headings', () => {
    const summary = [
      '**نظرة عامة (00:00–00:05):** مقدمة عن الاجتماع.',
      '**الميزانية (00:10–00:30):** نقاش الميزانية.',
      '**بنود التنفيذ / Action points (00:35–00:40):** مهام.',
      '**الخطة (00:40–00:55):** خطوات الربع القادم.'
    ].join('\n')

    expect(deriveMoments(summary, transcript([]))).toEqual([
      { t: 10, label: 'الميزانية' },
      { t: 40, label: 'الخطة' }
    ])
  })

  it('skips an English action-points heading', () => {
    const summary = [
      '**Action points (00:00–00:10):** tasks',
      '**Budget (00:20–00:40):** money',
      '**Launch (00:50–01:05):** release'
    ].join('\n')

    expect(deriveMoments(summary, transcript([]))).toEqual([
      { t: 20, label: 'Budget' },
      { t: 50, label: 'Launch' }
    ])
  })

  it('dedupes moments whose times are within 15 seconds', () => {
    const summary = [
      '**البداية (00:00–00:05):** intro',
      '**تكرار قريب (00:10–00:14):** nearly same time',
      '**لاحق (00:30–00:40):** later'
    ].join('\n')

    expect(deriveMoments(summary, transcript([]))).toEqual([
      { t: 0, label: 'البداية' },
      { t: 30, label: 'لاحق' }
    ])
  })

  it('falls back to transcript lines when the summary has no time headings', () => {
    const lines = [0, 100, 200, 300, 400, 500].map((start) => line(start, `كلام رقم ${start}`))
    const moments = deriveMoments('**ملخص بلا توقيتات:** نص.', transcript(lines))

    // duration 600s -> 3 moments; step 2 -> lines at 0, 200, 400
    expect(moments.map((m) => m.t)).toEqual([0, 200, 400])
    expect(moments[0].label).toBe('كلام رقم 0')
  })

  it('truncates long fallback labels with an ellipsis', () => {
    const longText = 'كلمة '.repeat(12).trim()
    const moments = deriveMoments(
      'لا توجد أي عناوين هنا.',
      transcript([line(0, longText), line(100, 'قصير'), line(200, 'قصير آخر')], { duration: 300 })
    )

    expect(moments.length).toBeGreaterThanOrEqual(2)
    expect(moments[0].label.endsWith('…')).toBe(true)
  })

  it('caps fallback labels at six words', () => {
    const text = 'واحد اثنان ثلاثة أربعة خمسة ستة سبعة ثمانية'
    const moments = deriveMoments(
      'لا توجد عناوين.',
      transcript([line(0, text), line(100, 'ب'), line(200, 'ج')], { duration: 300 })
    )

    expect(moments[0].label.split(/\s+/)).toHaveLength(6)
  })

  it('returns no moments when the transcript is empty', () => {
    expect(deriveMoments('لا توجد عناوين.', transcript([]))).toEqual([])
  })

  it('strips dialect tags and bidi marks from labels', () => {
    const lines = [0, 100, 200].map((start) =>
      line(start, '[EG] كلام رقم ' + start)
    )
    const moments = deriveMoments('**ملخص بلا توقيتات:** نص.', transcript(lines, { duration: 300 }))

    expect(moments).toHaveLength(2)
    expect(moments[0].label.startsWith('[EG]')).toBe(false)
    expect(moments[0].label).toBe('كلام رقم 0')
  })

  it('ignores the key-points heading when it carries a time range', () => {
    const summary = [
      '**أهم النقاط (00:00–00:30):**',
      '**الميزانية (00:10–00:30):** نقاش.',
      '**الخطة (00:40–00:55):** خطوات.'
    ].join('\n')

    expect(deriveMoments(summary, transcript([]))).toEqual([
      { t: 10, label: 'الميزانية' },
      { t: 40, label: 'الخطة' }
    ])
  })
})

describe('transcriptToText', () => {
  it('includes timestamps and speakers and omits empty lines', () => {
    const t = transcript(
      [
        line(5, ' مرحبا بالجميع ', 'سارة'),
        line(65, '   ', 'أحمد'),
        line(3725, 'انتهى الاجتماع', 'أحمد')
      ],
      { duration: 125, speakers: ['سارة', 'أحمد'] }
    )
    const text = transcriptToText(t)
    const contentLines = text.split('\n').filter((l) => l.trim())

    expect(contentLines).toHaveLength(3) // header + 2 non-empty transcript lines
    expect(text).toContain('المدة: 02:05')
    expect(text).toContain('المتحدثون: سارة، أحمد')
    expect(text).toContain('[00:05] سارة: مرحبا بالجميع')
    expect(text).toContain('[01:02:05] أحمد: انتهى الاجتماع') // hour-prefixed stamp for 3725s
    expect(text.split('\n').filter((l) => l.includes('أحمد:')).length).toBe(1) // blank line dropped
  })

  it('uses a default title when no title is present', () => {
    expect(transcriptToText(transcript([]))).toContain('عنوان التسجيل: تسجيل')
  })
})

describe('summarizeTranscript (mock mode)', () => {
  const original = process.env.TAFREEGH_MOCK

  afterEach(() => {
    if (original === undefined) delete process.env.TAFREEGH_MOCK
    else process.env.TAFREEGH_MOCK = original
  })

  const lines = [0, 100, 200, 300, 400, 500].map((start) => line(start, `كلام ${start}`))

  it('returns the canned markdown without calling providers', async () => {
    process.env.TAFREEGH_MOCK = '1'
    const result = await summarizeTranscript({} as never, {} as never, transcript(lines))

    expect(result.provider).toBe('ollama')
    expect(result.model).toBe('qwen3:14b')
    expect(result.chunks).toBe(1)
    expect(result.markdown).toContain('**نظرة عامة:**')
    expect(result.markdown).toContain('**بنود التنفيذ / Action points:**')
  })

  it('honours the maxMoments option in mock mode', async () => {
    process.env.TAFREEGH_MOCK = '1'
    const result = await summarizeTranscript({} as never, {} as never, transcript(lines), {
      maxMoments: 2
    })

    expect(result.moments).toHaveLength(2)
  })
})
