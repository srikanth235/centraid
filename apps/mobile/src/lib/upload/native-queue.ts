// Device assembly of the upload queue (#419.4).
//
// Native-module imports live here and in `expo-native.ts` only; the queue,
// sealer and drainer take every one of these by injection so the vitest rig
// can exercise them.

import { File } from "expo-file-system";

import { replicaStorageDirectory } from "../../../modules/centraid-storage";
import { ExpoSqliteDriver } from "../replica/expo-sqlite-driver";
import type { PendingUploadGroup } from "../replica/storage-accounting";
import { webCryptoUploadCrypto } from "./crypto";
import type { UploadCrypto } from "./crypto";
import { enqueueLocalFile } from "./enqueue";
import type { EnqueueInput } from "./enqueue";
import { expoFileSource, expoPartPutter } from "./expo-native";
import { httpDirectTransferClient } from "./gateway-client";
import { planLegacyDatabaseMove } from "./legacy-db-location";
import { createNativeDigest } from "./native-digest";
import { TERMINAL_RETENTION_MS, UploadQueueStore } from "./store";
import type {
  NewUploadFollowup,
  UploadFollowupFactory,
  UploadFollowup,
  UploadItem,
} from "./store";
import { notifyUploadQueueChanged } from "./upload-notifications";
import { UploadDrainer } from "./uploader";
import type { DrainSummary, UploadPolicy } from "./uploader";

/**
 * The queue's own database, deliberately NOT the replica's — see the header of
 * `store.ts` for why. Production places it in the native durable,
 * backup-excluded replica directory so OS cache cleanup cannot evict intents.
 */
export const UPLOAD_DB_NAME = "centraid-uploads.db";

/**
 * ONE HANDLE, HELD BY WHOEVER STILL WANTS IT (#1014, P21).
 *
 * Five entry points opened this database and closed it again — boot's
 * reconcile, the Phone storage screen, the media producer, the transfer queue
 * and Photos' long-lived timeline engine — and expo-sqlite caches connections
 * by NAME, so all five were the SAME handle. Whichever finished first called
 * `closeSync()` on it and the others went on using a closed database:
 * `withDrainLock` serialises DRAINS, and none of these are drains.
 *
 * So the handle is reference-counted here, in the one module that owns it. A
 * `close()` while another holder is live is a no-op, and the last holder out
 * really does close. `withUploadQueue` is the shape every entry point should
 * use, because a caller that forgets its `close()` now leaks the handle rather
 * than merely leaking a wrapper.
 */
let shared:
  | { store: UploadQueueStore; holders: number; location: string | undefined }
  | undefined;

/**
 * Recover a ledger the old percent-encoded path stranded (#1014, R19). Runs at
 * most once per location per process, before the handle is opened; a failure
 * is not fatal — the queue opens empty at the right place and the sweep can be
 * retried on the next launch — but it is never silent (logs.md).
 */
const recoveredLocations = new Set<string>();

function recoverLegacyLedger(location: string): void {
  if (recoveredLocations.has(location)) return;
  recoveredLocations.add(location);
  try {
    const moves = planLegacyDatabaseMove(
      location,
      UPLOAD_DB_NAME,
      (path) => new File(path).exists
    );
    for (const move of moves) new File(move.from).move(new File(move.to));
    if (moves.length > 0) {
      console.log(
        `[centraid] uploads: recovered ${moves.length} queue file(s) from the percent-encoded path`
      );
    }
  } catch (error) {
    console.warn(
      `[centraid] uploads: could not recover the queue stranded at the percent-encoded path: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function acquireUploadStore(): UploadQueueStore {
  const location = replicaStorageDirectory();
  if (location) recoverLegacyLedger(location);
  if (shared && shared.location !== location) {
    // The durable directory moved (a restored container). The old handle names
    // a file that is not this one; nobody may keep holding it.
    shared.store.close();
    shared = undefined;
  }
  shared ??= {
    store: UploadQueueStore.create(
      ExpoSqliteDriver.open({
        name: UPLOAD_DB_NAME,
        ...(location ? { location } : {}),
      })
    ),
    holders: 0,
    location,
  };
  shared.holders += 1;
  return shared.store;
}

function releaseUploadStore(): void {
  if (!shared) return;
  shared.holders -= 1;
  if (shared.holders > 0) return;
  shared.store.close();
  shared = undefined;
}

/** How many holders the shared handle has right now. For the suites. */
export function uploadStoreHolders(): number {
  return shared?.holders ?? 0;
}

export interface UploadQueueOptions {
  gatewayBaseUrl: string;
  /** Extra headers for gateway calls (e.g. Authorization in manual dev mode). */
  headers?: () => Record<string, string>;
  policy?: UploadPolicy;
  onProgress?: (progress: { completed: number; total: number }) => void;
  /** Overridable for tests; defaults to the ambient WebCrypto. */
  crypto?: UploadCrypto;
}

export class UploadQueue {
  private released = false;

  private constructor(
    private readonly store: UploadQueueStore,
    private readonly drainer: UploadDrainer,
    private readonly deps: { newId: () => string }
  ) {}

  static open(options: UploadQueueOptions): UploadQueue {
    const store = acquireUploadStore();
    const scope = { gatewayBaseUrl: options.gatewayBaseUrl };
    const drainer = new UploadDrainer({
      store,
      client: httpDirectTransferClient({
        gatewayBaseUrl: options.gatewayBaseUrl,
        ...(options.headers ? { headers: options.headers } : {}),
      }),
      crypto: options.crypto ?? webCryptoUploadCrypto(),
      openFile: expoFileSource,
      putPart: expoPartPutter(scope),
      gatewayBaseUrl: options.gatewayBaseUrl,
      // The resume guard must hash with the same implementation the enqueue
      // did, or every resumed item would look rewritten (#1014, P22).
      createDigest: createNativeDigest,
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.onProgress
        ? {
            onProgress: ({ completed, total }) =>
              options.onProgress?.({ completed, total }),
          }
        : {}),
    });
    return new UploadQueue(store, drainer, {
      newId: () =>
        `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    });
  }

  /** Address the bytes and durably queue them. Idempotent by content sha. */
  async enqueue(
    input: EnqueueInput,
    makeFollowup?: UploadFollowupFactory
  ): Promise<UploadItem> {
    const item = await enqueueLocalFile(
      {
        store: this.store,
        openFile: expoFileSource,
        newId: this.deps.newId,
        createDigest: createNativeDigest,
      },
      input,
      makeFollowup
    );
    // The writer announces; nobody polls (#996 wave 3).
    notifyUploadQueueChanged();
    return item;
  }

  /**
   * One resumable pass. Safe to call at any time from any lifecycle: recovery,
   * foreground reconciliation and a foreground-service drain are all just this.
   * When Android 15 stops a `dataSync` service at its 6h cap, the next call
   * resumes from the queue rather than restarting the work.
   */
  async drain(): Promise<DrainSummary> {
    // Announced in a `finally`: a pass that threw part-way still moved rows,
    // and a badge left on the old answer is the failure this replaces.
    try {
      return await this.drainer.drainOnce();
    } finally {
      notifyUploadQueueChanged();
    }
  }

  pending(): UploadItem[] {
    return this.store.pending();
  }

  /** Per-target-vault pending bytes/counts, aggregated in SQL — no rows. */
  pendingStorageGroups(): PendingUploadGroup[] {
    return this.store.pendingStorageGroups();
  }

  /** Ledger lookup by (content sha, vault) — the F11 probe and the F6 outcome
   *  check. Scoped since #1014 P3: the same bytes may be queued for two vaults. */
  bySha(sha256: string, targetVaultId?: string): UploadItem | undefined {
    return this.store.bySha(sha256, targetVaultId);
  }

  all(): UploadItem[] {
    return this.store.all();
  }

  /** Bounded newest-first slice; what a screen wants (#1014, P25). */
  recent(limit?: number): UploadItem[] {
    return this.store.recent(limit);
  }

  /** Terminally failed rows the member has not dismissed (#1014, P7). */
  failed(): UploadItem[] {
    return this.store.failed();
  }

  failedCount(): number {
    return this.store.failedCount();
  }

  /** Rows that failed and will try again, backoff window included (#1014). */
  retrying(): UploadItem[] {
    return this.store.retrying();
  }

  /** Put a failed row back in the queue with a fresh attempt budget. */
  retry(itemId: string): void {
    this.store.retry(itemId);
    notifyUploadQueueChanged();
  }

  dismissFailed(itemId: string): void {
    this.store.dismissFailed(itemId);
    notifyUploadQueueChanged();
  }

  /** Retention sweep over terminal rows nothing waits on (#1014, P25). */
  sweepTerminal(olderThanMs: number = TERMINAL_RETENTION_MS): number {
    return this.store.sweepTerminal({ olderThanMs });
  }

  enqueueFollowup(followup: NewUploadFollowup): UploadFollowup {
    return this.store.enqueueFollowup(followup);
  }

  /** Merge fields into the writes this item still has to make (#1014, R17). */
  amendFollowupInput(
    itemId: string,
    patch: Record<string, unknown>
  ): UploadFollowup[] {
    return this.store.amendFollowupInput(itemId, patch);
  }

  pendingFollowups(): UploadFollowup[] {
    return this.store.pendingFollowups();
  }

  hasFollowupForItem(itemId: string): boolean {
    return this.store.hasFollowupForItem(itemId);
  }

  clearFollowup(followupId: number): void {
    this.store.clearFollowup(followupId);
  }

  countFollowupAttempt(followupId: number): number {
    return this.store.countFollowupAttempt(followupId);
  }

  poisonFollowup(followupId: number, reason: string): void {
    this.store.poisonFollowup(followupId, reason);
  }

  poisonedFollowupCount(): number {
    return this.store.poisonedFollowupCount();
  }

  /**
   * Let go of the shared handle. Idempotent, and NOT necessarily a close:
   * another entry point may still be holding it (see the header).
   */
  close(): void {
    if (this.released) return;
    this.released = true;
    releaseUploadStore();
  }
}

/**
 * Open the queue, do something with it, and let go — the shape every entry
 * point should take (#1014, P21). A `finally` nobody can forget.
 */
export async function withUploadQueue<T>(
  options: UploadQueueOptions,
  work: (queue: UploadQueue) => Promise<T> | T
): Promise<T> {
  const queue = UploadQueue.open(options);
  try {
    return await work(queue);
  } finally {
    queue.close();
  }
}
