// Per-conversation composer draft persistence (#420). The composer's
// text survives navigation + reload, keyed by conversation id in localStorage
// and cleared on send. A fresh (uncreated) thread uses a stable `:new` key so a
// half-typed first message isn't lost either.

const PREFIX = "centraid.assistant.draft.";

function keyFor(conversationId: string | undefined): string {
  return `${PREFIX}${conversationId ?? ":new"}`;
}

export function loadDraft(conversationId: string | undefined): string {
  try {
    return localStorage.getItem(keyFor(conversationId)) ?? "";
  } catch {
    return "";
  }
}

export function clearDraft(conversationId: string | undefined): void {
  dropQueued(keyFor(conversationId));
  try {
    localStorage.removeItem(keyFor(conversationId));
  } catch {
    /* ignore */
  }
}

// `localStorage` is synchronous and blocks the main thread, so writing the
// draft on every keystroke put a disk-backed write between the key and the
// character appearing (#659). Persistence is a safety net measured in
// seconds, not frames: coalesce keystrokes and write once they pause. Every
// path that must not lose the last character — send, thread switch, unmount —
// flushes explicitly, so the debounce can never eat a draft.
const DRAFT_WRITE_DELAY_MS = 400;
let queuedKey: string | null = null;
let queuedText = "";
let queuedTimer: ReturnType<typeof setTimeout> | null = null;

function writeQueued(): void {
  if (queuedKey === null) return;
  const key = queuedKey;
  const text = queuedText;
  queuedKey = null;
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable / full — a lost draft is non-fatal */
  }
}

function dropQueued(key: string): void {
  if (queuedKey !== key) return;
  queuedKey = null;
  if (queuedTimer !== null) {
    clearTimeout(queuedTimer);
    queuedTimer = null;
  }
}

/** Persist `text` for this conversation shortly after typing stops. */
export function queueDraftSave(
  conversationId: string | undefined,
  text: string
): void {
  const key = keyFor(conversationId);
  // A different conversation's pending write must land before this one takes
  // the slot, or switching threads mid-keystroke would silently discard it.
  if (queuedKey !== null && queuedKey !== key) writeQueued();
  queuedKey = key;
  queuedText = text;
  if (queuedTimer !== null) clearTimeout(queuedTimer);
  queuedTimer = setTimeout(() => {
    queuedTimer = null;
    writeQueued();
  }, DRAFT_WRITE_DELAY_MS);
}

/** Write any pending draft now — send, thread switch, unmount. */
export function flushDraftSave(): void {
  if (queuedTimer !== null) {
    clearTimeout(queuedTimer);
    queuedTimer = null;
  }
  writeQueued();
}
