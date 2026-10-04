/**
 * `isValidLanguageCode`, inlined from the reference plugin's
 * `agents/language-directive.ts` (Step 16, E-group config port).
 *
 * Only the resolution half is ported: the fork's `language` config field
 * validates the code here, and the prose directive builder
 * (`buildContentLanguageDirective`) belongs to the historian/dreamer prompt
 * layer, which arrives with the C group. The implementation is copied verbatim
 * so the accepted code set stays identical to the reference — including the
 * `Intl.DisplayNames` based resolution that keeps a hardcoded language table out
 * of the fork.
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

const ENGLISH_LANGUAGE_NAMES = new Intl.DisplayNames(["en"], {
  type: "language",
  fallback: "none",
});

/**
 * Resolve a 2-letter ISO 639-1 code to the model-facing name string we validated
 * against weak models: "English (Endonym)", e.g. "tr" -> "Turkish (Türkçe)",
 * "es" -> "Spanish (Español)". A name (not a bare code) is what makes a weak
 * model reliably write in-language. Built from Intl.DisplayNames, so there is no
 * hardcoded language table to maintain. Returns "" for anything that is not a
 * resolvable 2-letter code, so an unset OR invalid value emits no directive.
 */
export function resolveLanguageName(language?: string): string {
  const code = typeof language === "string" ? language.trim().toLowerCase() : "";
  if (!/^[a-z]{2}$/.test(code)) return "";
  let english: string | undefined;
  try {
    english = ENGLISH_LANGUAGE_NAMES.of(code) ?? undefined;
  } catch {
    return "";
  }
  if (!english) return "";
  let endonym: string | undefined;
  try {
    endonym =
      new Intl.DisplayNames([code], { type: "language", fallback: "none" }).of(code) ?? undefined;
  } catch {
    endonym = undefined;
  }
  // english === endonym for self-named languages (e.g. "en" -> "English").
  return endonym && endonym !== english ? `${english} (${endonym})` : english;
}

/** True when `language` is a resolvable 2-letter ISO 639-1 code. */
export function isValidLanguageCode(language?: string): boolean {
  return resolveLanguageName(language) !== "";
}
