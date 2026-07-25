import type { ConversationHistoryStore } from '../conversation/history.js';

/** A file uploaded to the blob CAS before the turn, referenced by its hash. */
export interface TurnAttachmentRef {
  hash: string;
  mime: string;
  filename?: string;
  sizeBytes?: number;
}

const ATTACHMENT_HASH_RE = /^[a-f0-9]{64}$/;

/**
 * Parse+validate the `attachments` field of a `_turn` POST body (issue
 * #190's wire shape) — shared by every `_turn`-shaped route (the per-app
 * surface and the vault assistant's shell-level surface) so both validate
 * identically. Anything malformed is silently dropped rather than
 * rejecting the whole turn — a bad ref just means that one file doesn't ride.
 */
export function parseTurnAttachmentRefs(raw: unknown): TurnAttachmentRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is TurnAttachmentRef => {
    if (!a || typeof a !== 'object') return false;
    const r = a as Partial<TurnAttachmentRef>;
    return (
      typeof r.hash === 'string' && ATTACHMENT_HASH_RE.test(r.hash) && typeof r.mime === 'string'
    );
  });
}

/**
 * Resolve validated attachment refs to on-disk blob paths for the runner's
 * multimodal content blocks — the shape `ConversationTurnInput.attachments`
 * expects. `appId` scopes the blob CAS lookup (an app id, or `_assistant`).
 */
export function resolveTurnAttachments(
  conversationStore: ConversationHistoryStore | undefined,
  appId: string,
  refs: readonly TurnAttachmentRef[],
): { path: string; mime: string; filename?: string }[] {
  if (!conversationStore || refs.length === 0) return [];
  return refs.map((a) => ({
    path: conversationStore.blobPathFor(appId, a.hash),
    mime: a.mime,
    ...(a.filename !== undefined ? { filename: a.filename } : {}),
  }));
}

/**
 * Serialize work on `(appId, conversationId)` so a second POST queues behind the
 * first. The route handler awaits the previous tail before scheduling its
 * own. The lock entry is cleared lazily once the current task settles.
 *
 * The lock map is per-runtime — held on the `Runtime` instance and threaded
 * through the route context. A module-level map would collide across
 * gateways that share an `appId` (two profiles can install the same
 * template). See issue #113.
 */
export async function withConversationLock<T>(
  conversationLocks: Map<string, Promise<void>>,
  appId: string,
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${appId}::${conversationId}`;
  const previous = conversationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => (release = resolve));
  // The map holds the *chained* tail (previous → next) so newer callers
  // await everything ahead of them. Keep a reference to that exact promise
  // so the cleanup branch can identify "nobody else queued after me".
  const chained = previous.then(() => next);
  conversationLocks.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (conversationLocks.get(key) === chained) conversationLocks.delete(key);
  }
}
