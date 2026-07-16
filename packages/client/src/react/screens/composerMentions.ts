/*
 * Composer autocomplete helpers (issue #420, Wave 3) — the pure, framework-free
 * core of the shell assistant composer's @-mentions + slash-commands.
 *
 * Why shell-local React (not a shared kit sibling): the kit's
 * `attachMentionPopover` (kit.js) pokes an *uncontrolled* DOM textarea via a
 * body-appended layer, hard-codes a cookie-auth `fetch('/centraid/_vault/picker')`
 * with no injectable search hook, and styles itself with global kit.css classes.
 * The shell composer is a *controlled* React textarea authed by a bearer token
 * through `searchVaultEntities`, styled with CSS modules. Per the Wave-0 audit,
 * a React reimplementation over the same endpoints is the right call — the only
 * genuinely shareable bits are these tiny pure functions (token detection + the
 * `@[label](ref:type/id)` splice), duplicated here rather than paying for a
 * new tri-allowlist kit sibling + a kit.js refactor. The emitted ref string
 * exactly matches what the shared renderer parses (gfm.js's ref regex).
 */

/** A detected token under the caret: the `@`/`/` position and the text after it. */
export interface CaretToken {
  /** Index of the trigger char (`@` or `/`) in the text. */
  start: number;
  /** The query text between the trigger and the caret. */
  query: string;
}

const MAX_MENTION_LEN = 40;

/**
 * The `@mention` token immediately left of `caret`, or null. Fires only at a
 * word boundary (start-of-text or after whitespace / `(`), rejects tokens with
 * whitespace/newlines, and caps length — mirrors the kit's `tokenAtCaret`.
 */
export function mentionTokenAt(text: string, caret: number): CaretToken | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at < 0) return null;
  const before = at === 0 ? ' ' : upto[at - 1];
  if (before !== undefined && !/[\s(]/.test(before)) return null;
  const query = upto.slice(at + 1);
  if (query.length > MAX_MENTION_LEN) return null;
  if (/[\s\n]/.test(query)) return null;
  return { start: at, query };
}

/**
 * The leading `/command` token, or null. Only fires when `/` is the very first
 * character of the message and the caret is within the command word (no spaces
 * yet) — a slash mid-sentence is just a slash.
 */
export function slashCommandAt(text: string, caret: number): CaretToken | null {
  if (text[0] !== '/') return null;
  const upto = text.slice(0, caret);
  const query = upto.slice(1);
  if (/\s/.test(query)) return null;
  return { start: 0, query };
}

/** The canonical inline-ref string the shared renderer hydrates into a chip. */
export function refString(label: string, type: string, id: string): string {
  // Labels can't contain `]`; strip it so the `@[label](...)` bracket stays valid.
  const safeLabel = label.replace(/[\]]/g, '').trim() || `${type} ${id}`;
  return `@[${safeLabel}](ref:${type}/${id})`;
}

/**
 * Splice a chosen entity's ref into `text`, replacing the `@…` token that runs
 * from `start` to `caret`. Returns the new text and the caret position just
 * after the inserted ref (with a trailing space).
 */
export function insertRef(
  text: string,
  start: number,
  caret: number,
  entity: { label: string; type: string; id: string },
): { text: string; caret: number } {
  const ref = `${refString(entity.label, entity.type, entity.id)} `;
  const next = text.slice(0, start) + ref + text.slice(caret);
  return { text: next, caret: start + ref.length };
}

/** Remove a leading `/command` token (through the caret) — after it runs. */
export function clearSlash(text: string, caret: number): string {
  return text.slice(0, 0) + text.slice(caret);
}
