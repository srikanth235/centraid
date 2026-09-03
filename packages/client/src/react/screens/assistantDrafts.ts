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
    // Intentionally empty.
  }
}

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
    // Intentionally empty.
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
