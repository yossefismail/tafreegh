export interface SummaryModel {
  id: string
  /** Minimum VRAM (MB) where this model stays comfortable. */
  vramMb: number
  /** Approximate Ollama download size in GB. */
  sizeGb: number
  ar: string
  en: string
}

/**
 * Gemma 4 tags published on the Ollama registry, ordered smallest to largest.
 * The wizard and the home screen use this to recommend a summarizer that fits
 * the machine instead of always suggesting the biggest model.
 */
export const SUMMARY_MODELS: SummaryModel[] = [
  {
    id: 'gemma4:e2b',
    vramMb: 4000,
    sizeGb: 4.6,
    ar: 'الأخف — للأجهزة المتواضعة أو الذاكرة الصغيرة',
    en: 'Lightest — low-end machines or little memory'
  },
  {
    id: 'gemma4:e4b',
    vramMb: 6000,
    sizeGb: 6.6,
    ar: 'موصى به — أفضل توازن بين السرعة والدقة',
    en: 'Recommended — best balance of speed and accuracy'
  },
  {
    id: 'gemma4:12b',
    vramMb: 12000,
    sizeGb: 8.0,
    ar: 'أدق — يحتاج 12 جيجابايت ذاكرة رسومية أو أكثر',
    en: 'More accurate — needs 12 GB+ VRAM'
  },
  {
    id: 'gemma4:31b',
    vramMb: 24000,
    sizeGb: 20.4,
    ar: 'الأعلى دقة — لبطاقات 24 جيجابايت أو أكثر',
    en: 'Highest accuracy — 24 GB+ VRAM'
  }
]

/** Smallest Gemma 4 tag whose comfort threshold fits the detected GPU. */
export function recommendSummaryModel(vramMb?: number): string {
  if (typeof vramMb !== 'number' || vramMb <= 0) return 'gemma4:e4b'
  let pick = SUMMARY_MODELS[0]
  for (const model of SUMMARY_MODELS) {
    if (vramMb >= model.vramMb) pick = model
  }
  return pick.id
}
