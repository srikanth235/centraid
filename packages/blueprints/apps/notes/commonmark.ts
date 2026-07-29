/**
 * The portable Notes source contract. Bodies stay plain CommonMark text; the
 * editor never serializes a private rich-text AST. Wikilinks are an extension
 * over that source and compile to canonical core.link rows separately.
 */
export interface WikiLinkToken {
  raw: string;
  label: string;
  start: number;
  end: number;
}

const WIKILINK = /\[\[(?<label>[^\]\n]{1,160})\]\]/gu;

export function parseWikiLinks(source: unknown): WikiLinkToken[] {
  const text = String(source ?? "");
  return [...text.matchAll(WIKILINK)].flatMap((match) => {
    const raw = match[0];
    const label = match.groups?.label?.trim();
    const start = match.index;
    if (!raw || !label || start === undefined) return [];
    return [{ raw, label, start, end: start + raw.length }];
  });
}

/** Replace CRLF only; every other byte remains user-authored CommonMark. */
export function normalizeCommonMark(source: unknown): string {
  return String(source ?? "").replace(/\r\n?/gu, "\n");
}
