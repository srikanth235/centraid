// Pin STATE is durable. Pin BYTES accounting is NOT wired: `pinnedBytes()`
// returns `unavailable` on purpose — a fabricated 0 would be read as a budget.

import { Store } from "../../storage";

/** Scoped because content ids are minted per vault and collide across vaults. */
export interface ContentRef {
  scopeId: string;
  contentId: string;
}

interface PinRecord {
  ref: ContentRef;
  pinnedAt: string;
}

const STORE_KEY = "fetchGate.pinnedContent";

function refKey(ref: ContentRef): string {
  return `${ref.scopeId}:${ref.contentId}`;
}

/** Call once at app start, alongside the rest of `Store.hydrate` calls. */
export async function hydratePinnedContent(): Promise<void> {
  await Store.hydrate<PinRecord[]>(STORE_KEY, []);
}

function readAll(): PinRecord[] {
  return Store.get<PinRecord[]>(STORE_KEY, []);
}

function writeAll(records: PinRecord[]): void {
  Store.set(STORE_KEY, records);
}

export function pinContent(ref: ContentRef): void {
  const key = refKey(ref);
  const records = readAll();
  if (records.some((r) => refKey(r.ref) === key)) return;
  writeAll([...records, { ref, pinnedAt: new Date().toISOString() }]);
}

export function unpinContent(ref: ContentRef): void {
  const key = refKey(ref);
  writeAll(readAll().filter((r) => refKey(r.ref) !== key));
}

export function isPinned(ref: ContentRef): boolean {
  const key = refKey(ref);
  return readAll().some((r) => refKey(r.ref) === key);
}

export function listPinnedContent(): readonly ContentRef[] {
  return readAll().map((r) => r.ref);
}

export type PinnedBytesAnswer =
  | { status: "known"; bytes: number }
  | { status: "unavailable"; reason: string };

/** Always `unavailable` today — a function so the first byte source changes this body. */
export function pinnedBytes(): PinnedBytesAnswer {
  return {
    reason:
      "pinned-byte accounting is not wired to on-disk storage yet — pin state above is real, byte totals are not",
    status: "unavailable",
  };
}
