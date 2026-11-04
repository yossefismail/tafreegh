import type { ProviderInfo, UiLanguage } from '@shared/types'

/**
 * Arabic UI still needs the provider's real name: transliterations like
 * "ديب سيك" are ambiguous, so cloud and local providers are shown as
 * "ديب سيك · DeepSeek".
 */
export function providerLabel(
  info: ProviderInfo | undefined | null,
  language: UiLanguage
): string {
  if (!info) return ''
  return language === 'ar' ? `${info.nameAr} · ${info.name}` : info.name
}
