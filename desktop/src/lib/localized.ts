import type { LocalizedText } from '../types/work'

/**
 * Resolve a LocalizedText for the current locale: exact locale, then `en`,
 * then the first value present — so a role file written only in Chinese still
 * renders on an English UI rather than showing nothing.
 */
export function pickLocalized(text: LocalizedText | undefined, locale: string): string {
  if (text === undefined) return ''
  if (typeof text === 'string') return text
  const exact = text[locale]
  if (typeof exact === 'string') return exact
  if (typeof text.en === 'string') return text.en
  const first = Object.values(text).find((v) => typeof v === 'string')
  return first ?? ''
}
