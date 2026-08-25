/* oxlint-disable no-await-in-loop -- the run is serial BY CONTRACT: one
   original in flight at a time bounds memory on a phone, keeps the determinate
   "N of M" count truthful, and makes a mid-run pause resume at a clean row.
   Collecting the promises would parallelise the transfers and break all three. */
// THE SERIAL TRANSFER RUN — app-agnostic (#711).
//
// This was `runBackup` inside `apps/photos/photos-backup.ts`. Nothing about the
// loop was ever about photographs: it walks entries, resolves each one's bytes
// at the moment it reaches the head of the queue, hands them to a durable
// producer one at a time, and reports two outcomes the caller has to be able to
// state — a run that stopped early, and entries whose bytes were not on the
// device to send. Docs' scans and Notes' attachments are the declared next
// callers (docs/blueprint-seats.md §Shared engines), so it lives in the frame.
//
// What the engine deliberately does NOT know: what a photograph is, what a
// capture group is, which producer settles the bytes, or which vault they land
// in. The caller binds all of that into `send`. The engine owns order, counting
// and failure shape — the three things every byte-bearing app would otherwise
// get subtly differently.
//
// DURABILITY IS NOT HERE, and must not move here: every entry that reaches
// `send` is written into the sqlite upload queue by the producer before a byte
// moves (`lib/upload/enqueue.ts`), so killing the process mid-run loses at most
// the un-enqueued tail. This loop is the ORDER, not the ledger.
//
// PROGRESS IS DETERMINATE — exact counts, never a spinner (§18). `sent` only
// ever counts bytes a producer accepted.

/** The byte-bearing apps that may enqueue. New callers add themselves here so
 *  the frame can always answer "who is moving bytes on this device?". */
export type TransferAppId = "photos" | "docs" | "notes" | "tally";

/** Bytes as the durable queue addresses them. */
export interface TransferBytes {
  localUri: string;
  filename?: string;
  mediaType: string;
  plaintextSize: number;
}

/**
 * One thing to send. `record` is the app's canonical facts — the engine treats
 * it as opaque and passes it straight back to `send`, which is why it is a type
 * parameter rather than `unknown`: Photos keeps its capture group typed without
 * the frame ever learning what one is.
 */
export interface TransferSend<Record_> {
  bytes: TransferBytes;
  record: Record_;
}

/** What identifies an entry to the app that queued it. */
export interface TransferEntryRef {
  /** The caller's own id. Reported back in `deferred`, never interpreted. */
  id: string;
  app: TransferAppId;
  /** The vault these bytes are FOR. Persisted by the producer on the queue row,
   *  so a background drain cannot mis-file them into whatever vault happens to
   *  be focused later (docs/mobile-offline.md §Background work). */
  targetVaultId?: string;
}

export interface TransferEntry<Record_> extends TransferEntryRef {
  /**
   * Resolve the bytes, LATE — at the head of the run, not when the entry was
   * built. One entry may yield several sends (a Live Photo is a still and a
   * paired movie, two durable uploads sharing one capture group).
   *
   * Throws {@link TransferSourceUnavailableError} when the bytes are simply not
   * on this device right now. That is not a failure: it is a fact about the
   * entry, and it must not stop the run.
   */
  open: () => Promise<Array<TransferSend<Record_>>>;
}

export interface TransferProgress {
  completed: number;
  total: number;
}

export interface TransferRunDeps<Record_> {
  /** Hand one addressed source to the durable producer. Bound by the caller to
   *  a session, a gateway and a canonical intent shape. */
  send: (
    send: TransferSend<Record_>,
    entry: TransferEntryRef
  ) => Promise<unknown>;
  onProgress: (progress: TransferProgress) => void;
}

export interface TransferRunOutcome {
  /** Sources a producer accepted this run. Determinate; never an estimate. */
  sent: number;
  /**
   * Entries whose bytes were not on the device. Never dropped on the floor:
   * the caller keeps them selected, or leaves them for the next sweep.
   */
  deferred: Set<string>;
  /** Set when the run stopped early. The raw reason — the CALLER owns the
   *  member-facing sentence, because "backup" and "scan" are different words
   *  for the same stall and the frame should not pick one. */
  pausedReason?: string;
}

/**
 * Thrown by `open()` when the bytes are addressable but absent — an iCloud
 * original that was never downloaded, an attachment evicted from a cache. The
 * message is already member-facing so a caller can quote it.
 */
export class TransferSourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferSourceUnavailableError";
  }
}

/**
 * Run the entries in order. Device reads and paired writes stay SERIAL: the run
 * is deliberately bounded for mobile memory and preserves capture order.
 */
export async function runTransfers<Record_>(
  entries: readonly TransferEntry<Record_>[],
  deps: TransferRunDeps<Record_>
): Promise<TransferRunOutcome> {
  const deferred = new Set<string>();
  let sent = 0;
  try {
    for (const entry of entries) {
      let sends: Array<TransferSend<Record_>>;
      try {
        sends = await entry.open();
      } catch (error) {
        if (!(error instanceof TransferSourceUnavailableError)) throw error;
        deferred.add(entry.id);
        continue;
      }
      for (const one of sends) {
        await deps.send(one, entry);
        sent += 1;
      }
    }
    return { sent, deferred };
  } catch (error) {
    // A stall keeps everything it already achieved: the count is real, the
    // deferred set is real, and the durable queue still holds the accepted
    // rows. The next run resumes from there rather than starting over.
    return {
      sent,
      deferred,
      pausedReason: error instanceof Error ? error.message : String(error),
    };
  }
}
