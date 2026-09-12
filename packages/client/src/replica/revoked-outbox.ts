// WHAT A REVOKED SEAT OWES THE MEMBER (#1014, C25/P24; ruling R-1014-12).
//
// Revocation is about the device's FUTURE ACCESS, not about the member's past
// writes. A queued intent is data they authored and were told was saved — "your
// unsent changes stay queued" is a sentence this product says out loud — and
// every path that took the copy away took it with them:
//
//   - the browser purged the seat file straight out of the intent drain,
//   - the phone unlinked the file and rejected every waiter,
//   - and both told the member the vault was removed, never that N edits went.
//
// SO THE UNSENT WORK IS EXPORTED BEFORE THE FILE GOES, AND THE COUNT IS
// RETURNED. Not "kept in the outbox" — the outbox is a table inside the file
// being deleted — but written beside it, as JSON, under a name a support
// session can ask for. The caller then has a number to say instead of silence.
//
// WHICH STATES COUNT AS UNSENT is the whole judgement here, and it is drawn at
// "did the gateway durably take this?":
//
//   - `queued`, `sending`, `parked` — no. `sending` included deliberately: an
//     answer this seat never saw is an answer it cannot claim, and the gateway
//     now keeps its idempotency ledger across revocation (X1), so a replay of
//     one it did take is deduped rather than doubled.
//   - `failed`, `conflict`, `conflict-base-missing` — no, and these still hold
//     the member's input, which is the thing that cannot be reconstructed.
//   - `awaiting-change` — YES, it was taken; the gateway committed and only
//     this seat's cursor is behind. Nothing to save.
//   - `executed`, `denied`, `expired` — settled. Nothing to save.

import type { IntentState, ReplicaIntent } from "./types.js";

const UNSENT: ReadonlySet<IntentState> = new Set<IntentState>([
  "queued",
  "sending",
  "parked",
  "failed",
  "conflict",
  "conflict-base-missing",
]);

/** The states an export must carry. Exported so a host can list only these. */
export const UNSENT_INTENT_STATES: readonly IntentState[] = [...UNSENT];

export function unsentIntents(
  intents: readonly ReplicaIntent[]
): ReplicaIntent[] {
  return intents.filter((intent) => UNSENT.has(intent.state));
}

/** Where a host puts the export. One per vault, so two never overwrite. */
export function revokedOutboxFileName(vaultId: string): string {
  // The vault id is a stable opaque identifier, but it reaches a FILESYSTEM
  // here, so anything that is not plainly safe is escaped rather than trusted.
  return `revoked-outbox-${encodeURIComponent(vaultId)}.json`;
}

export interface RevokedOutboxExport {
  readonly vaultId: string;
  readonly exportedAt: string;
  readonly count: number;
  readonly intents: readonly ReplicaIntent[];
}

export function serializeRevokedOutbox(
  vaultId: string,
  intents: readonly ReplicaIntent[],
  now = new Date().toISOString()
): string {
  const unsent = unsentIntents(intents);
  const body: RevokedOutboxExport = {
    vaultId,
    exportedAt: now,
    count: unsent.length,
    intents: unsent,
  };
  return JSON.stringify(body, null, 2);
}

/** Where a host can durably put one file. Absent hosts export nothing. */
export interface RevokedOutboxSink {
  write: (fileName: string, body: string) => Promise<void>;
}

export interface SaveUnsentOptions {
  readonly vaultId: string;
  /** The queue's own list. Read BEFORE anything is purged. */
  readonly intents: readonly ReplicaIntent[];
  readonly sink: RevokedOutboxSink | undefined;
  readonly now?: string;
}

/**
 * Save what the member has not sent, and say how much there was.
 *
 * THE COUNT IS RETURNED EVEN WHEN THE SINK IS ABSENT OR FAILS, and that is
 * deliberate: the number is the thing the member is owed a sentence about, and
 * a host that cannot write the file must still be able to say "there were N"
 * rather than reporting a clean removal. The boolean says which happened.
 */
export async function saveUnsentBeforePurge(
  options: SaveUnsentOptions
): Promise<{ count: number; saved: boolean }> {
  const unsent = unsentIntents(options.intents);
  if (unsent.length === 0) return { count: 0, saved: true };
  if (!options.sink) return { count: unsent.length, saved: false };
  try {
    await options.sink.write(
      revokedOutboxFileName(options.vaultId),
      serializeRevokedOutbox(
        options.vaultId,
        unsent,
        options.now ?? new Date().toISOString()
      )
    );
    return { count: unsent.length, saved: true };
  } catch {
    // A purge is not abandoned because the export failed: the device's access
    // is being removed and that must still happen. What changes is what the
    // caller can honestly say, which `saved: false` carries.
    return { count: unsent.length, saved: false };
  }
}
