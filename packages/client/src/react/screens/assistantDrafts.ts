// Per-conversation composer draft persistence (issue #420 §4). The composer's
// text survives navigation + reload, keyed by conversation id in localStorage
// and cleared on send. A fresh (uncreated) thread uses a stable `:new` key so a
// half-typed first message isn't lost either.

const PREFIX = 'centraid.assistant.draft.';

function keyFor(conversationId: string | undefined): string {
  return `${PREFIX}${conversationId ?? ':new'}`;
}

export function loadDraft(conversationId: string | undefined): string {
  try {
    return localStorage.getItem(keyFor(conversationId)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(conversationId: string | undefined, text: string): void {
  try {
    if (text) localStorage.setItem(keyFor(conversationId), text);
    else localStorage.removeItem(keyFor(conversationId));
  } catch {
    /* storage unavailable / full — a lost draft is non-fatal */
  }
}

export function clearDraft(conversationId: string | undefined): void {
  try {
    localStorage.removeItem(keyFor(conversationId));
  } catch {
    /* ignore */
  }
}
