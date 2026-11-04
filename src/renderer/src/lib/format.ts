export function formatDuration(seconds?: number): string {
  if (!seconds || seconds < 0.5) return '00:00'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes < 1) return '0 MB'
  if (bytes < 1000) return `${Math.round(bytes)} B`
  const mb = bytes / 1e6
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1e3))} KB`
  if (mb < 1000) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  return `${(mb / 1000).toFixed(2)} GB`
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatTime(iso: string, lang: 'ar' | 'en'): string {
  try {
    return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(iso))
  } catch {
    return ''
  }
}

export function formatDate(iso: string, lang: 'ar' | 'en'): string {
  try {
    return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }).format(new Date(iso))
  } catch {
    return iso.slice(0, 10)
  }
}

export type DateGroup = 'today' | 'yesterday' | 'thisWeek' | 'older'

export function dateGroup(iso: string): DateGroup {
  const date = new Date(iso)
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const diff = startToday - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round(diff / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return 'thisWeek'
  return 'older'
}

export function romanNumeral(index: number): string {
  return String(index + 1).padStart(2, '0')
}

export function speakerLabel(count: number, lang: 'ar' | 'en'): string {
  if (lang === 'ar') {
    if (count === 1) return 'متحدث واحد'
    if (count === 2) return 'متحدثان'
    return `${count} متحدثين`
  }
  return count === 1 ? '1 speaker' : `${count} speakers`
}

const ARABIC_SPEAKERS: Record<string, string> = {
  A: 'أ',
  B: 'ب',
  C: 'ج',
  D: 'د',
  E: 'هـ',
  F: 'و',
  G: 'ز',
  H: 'ح'
}

export function speakerName(label: string, lang: 'ar' | 'en'): string {
  const letter = label.replace(/^Speaker\s*/i, '').trim()
  if (lang === 'ar') return `متحدث ${ARABIC_SPEAKERS[letter] ?? letter}`
  return label.startsWith('Speaker') ? label : `Speaker ${letter}`
}
