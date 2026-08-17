/**
 * Localised text as stored in ~/.superai files.
 *
 * A plain string is "the same in every language". An object maps locale codes
 * to text; `en` is the fallback, and if even that is missing the first value
 * wins, so a file written only in Chinese still renders.
 */
export type LocalizedText = string | { en?: string; [locale: string]: string | undefined }

export function pickLocalized(text: LocalizedText | undefined, locale: string): string {
  if (text === undefined) return ''
  if (typeof text === 'string') return text
  const exact = text[locale]
  if (typeof exact === 'string') return exact
  if (typeof text.en === 'string') return text.en
  const first = Object.values(text).find((v) => typeof v === 'string')
  return first ?? ''
}

export function isLocalizedText(value: unknown): value is LocalizedText {
  if (typeof value === 'string') return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(
    (v) => v === undefined || typeof v === 'string',
  )
}
