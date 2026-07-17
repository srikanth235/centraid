// The drainer (#419 M0.4): turns durable queue rows into settled CAS objects.
//
// Every step is written so that a process death at ANY point leaves the queue
// recoverable from SQLite alone, with no duplicate object and no lost item:
//
//  * `begin` is keyed by content sha, so it is the resume primitive AND the
//    D10 dedupe check. Re-begin returns the same session plus the parts the
//    gateway has already accepted; `alreadyPresent` means transfer nothing.
//  * A part's ETag is persisted BEFORE the gateway receipt is requested, so a
//    crash in that window replays the receipt instead of re-uploading bytes.
//  * Re-sealing is byte-identical (see cbsf.ts), so even a lost ETag costs
//    only a repeated PUT of the exact same object, never a divergent one.
//  * `complete` is the settlement point; the receipt it returns is the only
//    thing that marks an item settled. A crash before persisting it re-begins,
//    finds `alreadyPresent`, and settles from there.

import { assertGatewayMintedUploadUrl } from '../bridge/transfer-policy';
import { partCountFor, sealDirectory, sealPart } from './cbsf';
import type { UploadCrypto } from './crypto';
import { base64ToBytes } from './bytes';
import type { FileSourceOpener } from './file-source';
import {
  DirectTransferError,
  type DirectTransferClient,
  type MultipartPartReceipt,
  type SettlementReceipt,
} from './gateway-client';
import type { UploadItem, UploadQueueStore } from './store';

const MAX_ATTEMPTS = 5;
const DEFAULT_PART_CONCURRENCY = 3;

/** Puts one sealed part and returns the provider's ETag. */
export type PartPutter = (input: {
  url: string;
  body: Uint8Array;
  transferId: string;
}) => Promise<string | null>;

/**
 * Network-policy seam (Wi-Fi-only, charger-only). M1 owns the real policy;
 * the drainer only asks. Returning false halts the drain cleanly, leaving
 * every item recoverable.
 */
export interface UploadPolicy {
  canTransfer(): boolean | Promise<boolean>;
}

export interface UploadDrainerDeps {
  store: UploadQueueStore;
  client: DirectTransferClient;
  crypto: UploadCrypto;
  openFile: FileSourceOpener;
  putPart: PartPutter;
  /** Gateway base URL, used to pin every presigned URL before any PUT. */
  gatewayBaseUrl: string;
  fetchImpl?: typeof fetch;
  partConcurrency?: number;
  policy?: UploadPolicy;
  /** Progress for the Android foreground-service notification. */
  onProgress?: (progress: DrainProgress) => void;
}

export interface DrainProgress {
  completed: number;
  total: number;
  sha256: string;
}

export interface DrainSummary {
  settled: number;
  failed: number;
  deduped: number;
  halted: boolean;
}

export class UploadDrainer {
  constructor(private readonly deps: UploadDrainerDeps) {}

  /**
   * One pass over every non-terminal item, oldest first. Recovery needs no
   * special path: a restart simply calls this, because the queue's own rows
   * are the only state that matters.
   */
  async drainOnce(): Promise<DrainSummary> {
    const summary: DrainSummary = { settled: 0, failed: 0, deduped: 0, halted: false };
    const items = this.deps.store.pending();
    for (const [index, item] of items.entries()) {
      if (!(await this.allowed())) {
        summary.halted = true;
        return summary;
      }
      this.deps.onProgress?.({ completed: index, total: items.length, sha256: item.sha256 });
      try {
        const outcome = await this.driveItem(item);
        if (outcome === 'deduped') summary.deduped += 1;
        summary.settled += 1;
      } catch (error) {
        if (isKill(error)) throw error;
        const terminal =
          (error instanceof DirectTransferError && error.terminal) ||
          item.attempts + 1 >= MAX_ATTEMPTS;
        this.deps.store.fail(item.itemId, messageOf(error), terminal);
        if (terminal) summary.failed += 1;
      }
    }
    return summary;
  }

  private async allowed(): Promise<boolean> {
    return (await this.deps.policy?.canTransfer()) ?? true;
  }

  private async driveItem(item: UploadItem): Promise<'settled' | 'deduped'> {
    this.deps.store.countAttempt(item.itemId);
    const plan = await this.deps.client.begin({
      sha256: item.sha256,
      plaintextSize: item.plaintextSize,
      sealedSize: item.sealedSize,
      partCount: item.partCount,
      ...(item.mediaType ? { mediaType: item.mediaType } : {}),
      ...(item.filename ? { filename: item.filename } : {}),
    });

    // D10: the gateway already holds these bytes. Nothing to transfer. The
    // gateway alone is authoritative about durability: persist its settlement
    // receipt verbatim. If (defensively) it issued none, settle WITHOUT a
    // casAck — an absent casAck safely withholds device-original deletion,
    // where a fabricated `replicated` would authorize it.
    if (plan.alreadyPresent) {
      this.deps.store.settle(
        item.itemId,
        plan.settlement ?? { alreadyPresent: true, custody: plan.custody },
      );
      return 'deduped';
    }
    if (!plan.sessionId || !plan.upload) {
      throw new Error('gateway opened no direct session and reported no existing blob');
    }
    this.deps.store.markBegun(item.itemId, plan.sessionId);

    // The gateway's completedParts are authoritative over local part state.
    for (const part of plan.completedParts) {
      this.deps.store.markPartRecorded(item.itemId, part.partNumber, part.etag);
    }
    this.deps.store.setState(item.itemId, 'uploading');

    const key = base64ToBytes(plan.keyBase64);
    if (key.byteLength !== 32) throw new Error('gateway returned a malformed content key');

    const urls = new Map<number, string>(
      plan.upload.kind === 'single'
        ? [[1, plan.upload.url]]
        : plan.upload.parts.map((part) => [part.partNumber, part.url]),
    );
    const directory = await sealDirectory(
      this.deps.crypto,
      key,
      item.sha256,
      item.plaintextSize,
      item.frameCount,
    );
    const source = await this.deps.openFile(item.localUri);
    try {
      if (source.size !== item.plaintextSize) {
        // The local file changed under us; its sha no longer addresses it.
        throw new DirectTransferError(
          `local file is ${source.size} bytes, expected ${item.plaintextSize}`,
          400,
        );
      }
      const outstanding = this.deps.store
        .parts(item.itemId)
        .filter((part) => part.state !== 'recorded');
      await this.drainParts(item, plan.sessionId, plan.upload.kind, {
        key,
        directory,
        urls,
        outstanding,
        read: (offset, length) => source.read(offset, length),
      });
    } finally {
      source.close();
    }

    this.deps.store.setState(item.itemId, 'completing');
    const receipts: MultipartPartReceipt[] =
      plan.upload.kind === 'multipart'
        ? this.deps.store
            .parts(item.itemId)
            .flatMap((part) =>
              part.etag ? [{ partNumber: part.partNumber, etag: part.etag }] : [],
            )
        : [];
    const receipt: SettlementReceipt = await this.deps.client.complete(plan.sessionId, receipts);
    this.deps.store.settle(item.itemId, receipt);
    return 'settled';
  }

  private async drainParts(
    item: UploadItem,
    sessionId: string,
    kind: 'single' | 'multipart',
    ctx: {
      key: Uint8Array;
      directory: Uint8Array;
      urls: Map<number, string>;
      outstanding: { partNumber: number; state: string; etag?: string }[];
      read: (offset: number, length: number) => Promise<Uint8Array>;
    },
  ): Promise<void> {
    const limit = kind === 'single' ? 1 : (this.deps.partConcurrency ?? DEFAULT_PART_CONCURRENCY);
    await pool(ctx.outstanding, limit, async (part) => {
      // The crash-window replay: bytes are already at the provider and the
      // ETag survived, only the gateway receipt did not. Replay the receipt.
      if (part.state === 'put' && part.etag) {
        if (kind === 'multipart') {
          await this.deps.client.recordPart(sessionId, part.partNumber, part.etag);
        }
        this.deps.store.markPartRecorded(item.itemId, part.partNumber, part.etag);
        return;
      }
      const url = ctx.urls.get(part.partNumber);
      if (!url) throw new Error(`gateway minted no URL for part ${part.partNumber}`);

      // Nothing is PUT anywhere the gateway did not mint. This resolves the
      // provider allowlist from the trusted gateway on every part.
      await assertGatewayMintedUploadUrl(url, {
        gatewayBaseUrl: this.deps.gatewayBaseUrl,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      });

      const body = await sealPart({
        crypto: this.deps.crypto,
        key: ctx.key,
        sha256: item.sha256,
        plaintextSize: item.plaintextSize,
        frameCount: item.frameCount,
        partNumber: part.partNumber,
        directory: ctx.directory,
        read: ctx.read,
      });
      const etag = await this.deps.putPart({
        url,
        body,
        transferId: `${sessionId}-${part.partNumber}`,
      });
      if (kind === 'multipart' && !etag) {
        throw new Error('provider did not expose the multipart ETag');
      }
      // Durability ordering: persist the receipt-to-be before asking the
      // gateway to record it.
      this.deps.store.markPartPut(item.itemId, part.partNumber, etag ?? '');
      if (kind === 'multipart') {
        await this.deps.client.recordPart(sessionId, part.partNumber, etag!);
      }
      this.deps.store.markPartRecorded(item.itemId, part.partNumber, etag ?? '');
    });
  }
}

/** Bounded-parallel map that surfaces the first error once all runners stop. */
async function pool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const errors: unknown[] = [];
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length || errors.length > 0) return;
      try {
        await work(items[index]!);
      } catch (error) {
        errors.push(error);
        return;
      }
    }
  });
  await Promise.all(runners);
  if (errors.length > 0) throw errors[0];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A simulated process death must never be caught and retried as if it were a
 * network error — the crash tests rely on it unwinding the whole drain.
 */
function isKill(error: unknown): boolean {
  return error instanceof Error && error.name === 'UploadKillSignalError';
}

export { partCountFor };
