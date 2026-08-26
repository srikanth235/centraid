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

// Coalesced because localStorage writes block the main thread (#659);
// explicit flushes (send/thread switch/unmount) guard the last character.
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
    /* lost draft is non-fatal */
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

export function queueDraftSave(
  conversationId: string | undefined,
  text: string
): void {
  const key = keyFor(conversationId);
  // A different conversation's pending write lands first.
  if (queuedKey !== null && queuedKey !== key) writeQueued();
  queuedKey = key;
  queuedText = text;
  if (queuedTimer !== null) clearTimeout(queuedTimer);
  queuedTimer = setTimeout(() => {
    queuedTimer = null;
    writeQueued();
  }, DRAFT_WRITE_DELAY_MS);
}

export function flushDraftSave(): void {
  if (queuedTimer !== null) {
    clearTimeout(queuedTimer);
    queuedTimer = null;
  }
  writeQueued();
}
