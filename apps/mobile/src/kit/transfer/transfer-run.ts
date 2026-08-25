/* oxlint-disable no-await-in-loop -- serial BY CONTRACT: parallelising breaks
   the memory bound, the truthful "N of M", and clean-row resume. */
// App-agnostic run (#711): owns ORDER, counting and failure shape, nothing else.
// Durability must not move here — the producer enqueues before a byte moves.

export type TransferAppId = "photos" | "docs" | "notes" | "tally";

export interface TransferBytes {
  localUri: string;
  filename?: string;
  mediaType: string;
  plaintextSize: number;
}

export interface TransferSend<Record_> {
  bytes: TransferBytes;
  record: Record_;
}

export interface TransferEntryRef {
  id: string;
  app: TransferAppId;
  /** Persisted on the queue row so a background drain cannot mis-file into the
   *  focused vault. */
  targetVaultId?: string;
}

export interface TransferEntry<Record_> extends TransferEntryRef {
  /** Resolves LATE, at the head of the run; may yield several sends. A thrown
   * {@link TransferSourceUnavailableError} must not stop the run. */
  open: () => Promise<Array<TransferSend<Record_>>>;
}

export interface TransferProgress {
  completed: number;
  total: number;
}

export interface TransferRunDeps<Record_> {
  send: (
    send: TransferSend<Record_>,
    entry: TransferEntryRef
  ) => Promise<unknown>;
  onProgress: (progress: TransferProgress) => void;
}

export interface TransferRunOutcome {
  sent: number;
  deferred: Set<string>;
  /** Raw reason; the CALLER owns the member-facing sentence. */
  pausedReason?: string;
}

/** The message is member-facing — callers quote it. */
export class TransferSourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferSourceUnavailableError";
  }
}

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
    return {
      sent,
      deferred,
      pausedReason: error instanceof Error ? error.message : String(error),
    };
  }
}
