import { promises as fs, statSync } from "node:fs";
import path from "node:path";

import type { ConversationHistoryStore } from "../conversation/history.js";
import type { ConversationWorkspaceKind } from "../conversation/schema.js";

/** A file uploaded to the blob CAS before the turn, referenced by its hash. */
export interface TurnAttachmentRef {
  hash: string;
  mime: string;
  filename?: string;
  sizeBytes?: number;
}

const ATTACHMENT_HASH_RE = /^[a-f0-9]{64}$/u;

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
    if (!a || typeof a !== "object") return false;
    const r = a as Partial<TurnAttachmentRef>;
    return (
      typeof r.hash === "string" &&
      ATTACHMENT_HASH_RE.test(r.hash) &&
      typeof r.mime === "string"
    );
  });
}

/**
 * Validate and canonicalize explicitly owner-selected extra workspace roots.
 * Persistence of the returned realpaths is the per-conversation consent
 * receipt; a symlink swap therefore cannot widen a later turn's authority.
 */
export async function parseAdditionalDirectories(
  raw: unknown
): Promise<string[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw))
    throw new Error("additionalDirectories must be an array.");
  const resolvedDirectories = await Promise.all(
    raw.map(async (value) => {
      if (typeof value !== "string" || !path.isAbsolute(value)) {
        throw new Error("Each additional directory must be an absolute path.");
      }
      const resolved = await fs.realpath(value);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory() || resolved === path.parse(resolved).root) {
        throw new Error(
          "Each additional directory must name a non-root directory."
        );
      }
      return resolved;
    })
  );
  const out: string[] = [];
  for (const resolved of resolvedDirectories) {
    if (!out.includes(resolved)) out.push(resolved);
    if (out.length > 8)
      throw new Error("At most eight additional directories may be shared.");
  }
  return out;
}

export function parseWorkspaceKind(
  raw: unknown
): ConversationWorkspaceKind | undefined {
  return raw === "vault-data" || raw === "app" || raw === "draft"
    ? raw
    : undefined;
}

/**
 * Resolve validated attachment refs to on-disk blob paths for the harness's
 * multimodal content blocks — the shape `ConversationTurnInput.attachments`
 * expects. `appId` scopes the blob CAS lookup (an app id, or `_assistant`).
 */
export function resolveTurnAttachments(
  conversationStore: ConversationHistoryStore | undefined,
  appId: string,
  refs: readonly TurnAttachmentRef[]
): { path: string; mime: string; filename?: string }[] {
  if (!conversationStore) return [];
  return validateTurnAttachmentRefs(conversationStore, appId, refs).map(
    (a) => ({
      path: conversationStore.blobPathFor(appId, a.hash),
      mime: a.mime,
      ...(a.filename === undefined ? {} : { filename: a.filename }),
    })
  );
}

/**
 * Keep only refs that name a real file in this app's CAS. When the sender
 * supplies a size receipt it must match the stored bytes, so a forged or
 * stale ref can neither enter the ledger nor reach a harness process.
 */
export function validateTurnAttachmentRefs(
  conversationStore: ConversationHistoryStore | undefined,
  appId: string,
  refs: readonly TurnAttachmentRef[]
): TurnAttachmentRef[] {
  if (!conversationStore || refs.length === 0) return [];
  return refs.filter((ref) => {
    try {
      const stat = statSync(conversationStore.blobPathFor(appId, ref.hash));
      return (
        stat.isFile() &&
        (ref.sizeBytes === undefined || stat.size === ref.sizeBytes)
      );
    } catch {
      return false;
    }
  });
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
  fn: () => Promise<T>
): Promise<T> {
  const key = `${appId}::${conversationId}`;
  const previous = conversationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
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
