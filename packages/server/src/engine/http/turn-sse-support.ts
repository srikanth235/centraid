import { promises as fs, statSync } from "node:fs";
import path from "node:path";

import type { ConversationHistoryStore } from "../conversation/history.js";
import type { ConversationWorkspaceKind } from "../conversation/schema.js";

export interface TurnAttachmentRef {
  hash: string;
  mime: string;
  filename?: string;
  sizeBytes?: number;
}

const ATTACHMENT_HASH_RE = /^[a-f0-9]{64}$/u;

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
