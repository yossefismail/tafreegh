export interface DialectOption {
  code: string
  ar: string
  en: string
}

export const DIALECTS: DialectOption[] = [
  { code: 'EG', ar: 'المصري (افتراضي)', en: 'Egyptian (default)' },
  { code: 'auto', ar: 'كشف تلقائي', en: 'Auto-detect' },
  { code: 'msa', ar: 'الفصحى', en: 'Modern Standard Arabic' },
  { code: 'ar', ar: 'عربي عام', en: 'Arabic (generic)' },
  { code: 'SA', ar: 'السعودي', en: 'Saudi' },
  { code: 'AE', ar: 'الإماراتي', en: 'Emirati' },
  { code: 'KW', ar: 'الكويتي', en: 'Kuwaiti' },
  { code: 'QA', ar: 'القطري', en: 'Qatari' },
  { code: 'BH', ar: 'البحريني', en: 'Bahraini' },
  { code: 'OM', ar: 'العماني', en: 'Omani' },
  { code: 'JO', ar: 'الأردني', en: 'Jordanian' },
  { code: 'PS', ar: 'الفلسطيني', en: 'Palestinian' },
  { code: 'LB', ar: 'اللبناني', en: 'Lebanese' },
  { code: 'SY', ar: 'السوري', en: 'Syrian' },
  { code: 'IQ', ar: 'العراقي', en: 'Iraqi' },
  { code: 'YE', ar: 'اليمني', en: 'Yemeni' },
  { code: 'SD', ar: 'السوداني', en: 'Sudanese' },
  { code: 'LY', ar: 'الليبي', en: 'Libyan' },
  { code: 'TN', ar: 'التونسي', en: 'Tunisian' },
  { code: 'DZ', ar: 'الجزائري', en: 'Algerian' },
  { code: 'MA', ar: 'المغربي', en: 'Moroccan' },
  { code: 'MR', ar: 'الموريتاني', en: 'Mauritanian' },
  { code: 'en', ar: 'إنجليزي', en: 'English' },
  { code: 'fr', ar: 'فرنسي', en: 'French' }
]

export const AUDIO_EXTENSIONS = [
  'm4a',
  'mp3',
  'wav',
  'ogg',
  'opus',
  'mp4',
  'aac',
  'flac',
  'wma',
  'webm',
  'mov',
  'mkv'
]

export function isAudioPath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return false
  const ext = name.slice(dot + 1).toLowerCase()
  return AUDIO_EXTENSIONS.includes(ext)
}
