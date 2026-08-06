// Pin/unpin: a content ref's offline-retention flag, kept independently of
// whatever quality rung happens to be on screen right now. A viewed photo's
// bytes can be evicted the moment the app backgrounds (image-cache.ts); a
// PINNED photo is a member's standing "keep this on the device" instruction —
// the API Docs' offline checkbox and Photos' future "keep original" affordance
// both need, per this task's brief (§3). UI-less by design: this ships the
// contract, the first consumer decides what the toggle looks like.
//
// STORAGE. Pin STATE (which refs are pinned) is real and durable — it rides
// the same `Store` (`apps/mobile/src/storage.ts`) the rest of mobile's
// preferences use, namespaced so it survives reload and is inspectable next
// to every other `centraid.v1.*` key.
//
// Pin BYTES accounting is NOT real yet, and this module says so rather than
// guessing. A honest per-ref byte count needs to know which content refs
// resolved to which on-disk file — today that mapping lives in each app's own
// cache/thumbnail-pack bookkeeping (see `pinned-thumbnails.ts`,
// `image-cache.ts`), not in one place this module can read. Wiring pinned
// bytes into the Phone storage screen's
// "replica database bytes / pinned thumbnail bytes / pending upload bytes"
// trio (docs/mobile-offline.md) is future work; `pinnedBytes()` below returns
// a stated-unavailable answer until that wiring exists, on purpose — a
// fabricated 0 or a stale number would be read as a real budget.

import { Store } from "../../storage";

/** One pinned thing, addressed the same way replica rows are: scope + content
 *  id. Scoped because content ids are minted per vault and collide across
 *  vaults by design (see multi-vault-reader.ts's SHA-dedupe notes). */
export interface ContentRef {
  scopeId: string;
  contentId: string;
}

interface PinRecord {
  ref: ContentRef;
  /** ISO timestamp, kept for "pinned since" surfaces and LRU-style review. */
  pinnedAt: string;
}

const STORE_KEY = "fetchGate.pinnedContent";

function refKey(ref: ContentRef): string {
  return `${ref.scopeId}:${ref.contentId}`;
}

/** Call once at app start, alongside the rest of `Store.hydrate` calls, so
 *  synchronous reads below see persisted state instead of an empty default. */
export async function hydratePinnedContent(): Promise<void> {
  await Store.hydrate<PinRecord[]>(STORE_KEY, []);
}

function readAll(): PinRecord[] {
  return Store.get<PinRecord[]>(STORE_KEY, []);
}

function writeAll(records: PinRecord[]): void {
  Store.set(STORE_KEY, records);
}

/** Pin a content ref for offline retention. Idempotent. */
export function pinContent(ref: ContentRef): void {
  const key = refKey(ref);
  const records = readAll();
  if (records.some((r) => refKey(r.ref) === key)) return;
  writeAll([...records, { ref, pinnedAt: new Date().toISOString() }]);
}

/** Unpin a content ref. Idempotent — unpinning something not pinned is a
 *  no-op, not an error, matching every other toggle-off in this app. */
export function unpinContent(ref: ContentRef): void {
  const key = refKey(ref);
  writeAll(readAll().filter((r) => refKey(r.ref) !== key));
}

export function isPinned(ref: ContentRef): boolean {
  const key = refKey(ref);
  return readAll().some((r) => refKey(r.ref) === key);
}

/** Every currently pinned ref, newest-pinned last. */
export function listPinnedContent(): readonly ContentRef[] {
  return readAll().map((r) => r.ref);
}

export type PinnedBytesAnswer =
  | { status: "known"; bytes: number }
  | { status: "unavailable"; reason: string };

/**
 * Total bytes held on-device for pinned content. Always `unavailable` today —
 * see the module comment. Kept as a real function (not a constant) so the
 * first caller that wires a byte source only has to change this body, not
 * every call site.
 */
export function pinnedBytes(): PinnedBytesAnswer {
  return {
    reason:
      "pinned-byte accounting is not wired to on-disk storage yet — pin state above is real, byte totals are not",
    status: "unavailable",
  };
}
