// Types for the dependency-free fenced-code highlighter (issue #420, Wave 2).

/** Internal scanner config for one language (opaque to callers). */
export interface HighlightLangConfig {
  line?: string;
  block?: [string, string];
  strings?: string;
  kw: ReadonlySet<string>;
  ci?: boolean;
  dollar?: boolean;
  triple?: boolean;
}

/** Resolve a fenced-code language tag to a scanner config, or null when unknown. */
export function configFor(lang: string | undefined): HighlightLangConfig | null;

/**
 * Highlight `code` for a known `lang` as an HTML string (escaped text + `hl…`
 * spans), or `null` when the language is unknown so the caller can fall back to
 * a plain escaped `<pre>`. Escape-by-default; never throws.
 */
export function highlightCode(code: string, lang?: string): string | null;
