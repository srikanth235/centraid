export interface CaretToken {
  start: number;
  query: string;
}

const MAX_MENTION_LEN = 40;

export function mentionTokenAt(text: string, caret: number): CaretToken | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  const before = at === 0 ? " " : upto[at - 1];
  if (before !== undefined && !/[\s(]/u.test(before)) return null;
  const query = upto.slice(at + 1);
  if (query.length > MAX_MENTION_LEN) return null;
  if (/[\s\n]/u.test(query)) return null;
  return { start: at, query };
}

export function slashCommandAt(text: string, caret: number): CaretToken | null {
  if (text[0] !== "/") return null;
  const upto = text.slice(0, caret);
  const query = upto.slice(1);
  if (/\s/u.test(query)) return null;
  return { start: 0, query };
}

export function refString(label: string, type: string, id: string): string {
  const safeLabel = label.replace(/[\]]/gu, "").trim() || `${type} ${id}`;
  return `@[${safeLabel}](ref:${type}/${id})`;
}

export function insertRef(
  text: string,
  start: number,
  caret: number,
  entity: { label: string; type: string; id: string }
): { text: string; caret: number } {
  const ref = `${refString(entity.label, entity.type, entity.id)} `;
  const next = text.slice(0, start) + ref + text.slice(caret);
  return { text: next, caret: start + ref.length };
}

export function clearSlash(text: string, caret: number): string {
  return text.slice(0, 0) + text.slice(caret);
}
