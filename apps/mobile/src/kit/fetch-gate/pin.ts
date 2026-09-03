import { Store } from "../../storage";

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
