// The drainer (#419.4): durable queue rows → settled CAS objects. Death at
// ANY point leaves the queue recoverable from SQLite alone — no duplicate
// object, no lost item:
//  * `begin` is keyed by content sha: resume primitive AND D10 dedupe check;
//    `alreadyPresent` transfers nothing.
//  * A part's ETag is persisted BEFORE its gateway receipt is requested, so a
//    crash in that window replays the receipt instead of re-uploading bytes.
//  * Re-sealing is byte-identical (cbsf.ts): a lost ETag costs one repeated
//    PUT of the same object, never a divergent one.
//  * `complete` is settlement; its receipt is the only settled marker.

import { base64ToBytes } from "./bytes";
import { sealDirectory, sealPart } from "./cbsf";
import type { UploadCrypto } from "./crypto";
import { edgeDigestOfFile } from "./enqueue";
import type { StreamingDigest } from "./enqueue";
import type { FileSourceOpener } from "./file-source";
import { DirectTransferError } from "./gateway-client";
import type {
  DirectTransferClient,
  MultipartPartReceipt,
  SettlementReceipt,
} from "./gateway-client";
import { PENDING_PAGE_LIMIT } from "./store";
import type { UploadItem, UploadQueueStore } from "./store";
import {
  memberTransferFailure,
  transferFailureDetail,
} from "./transfer-failure";
import { assertGatewayMintedUploadUrl } from "./transfer-policy";

/** Attempts against a REACHABLE gateway before an item is terminally failed.
 *  A refusal the transport itself calls unreachable does not spend one — see
 *  `isUnreachable` (#1014). */
const MAX_ATTEMPTS = 5;

/**
 * Wait before an item's next attempt, indexed by attempts already spent
 * (#1014). Named rather than computed so the ceiling is readable and the
 * table is what a test asserts: a phone that hit a rejecting gateway used to
 * burn all five attempts inside one drain pass, seconds apart, and hand the
 * member a permanent failure for a blip.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [
  2_000, 15_000, 60_000, 300_000,
];

/** Up to this fraction of the delay is added at random, so a queue of 400
 *  items that failed together does not retry in lockstep. */
const BACKOFF_JITTER = 0.25;

/** The wait before the next try, given how many attempts are already spent
 *  (1 = the first retry). Jittered. */
export function retryDelayMs(
  attempts: number,
  random: () => number = Math.random
): number {
  const base =
    RETRY_BACKOFF_MS[
      Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MS.length) - 1
    ] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
  return Math.round(base * (1 + BACKOFF_JITTER * random()));
}
/** Parts in flight per item, and so the sealer's peak transient cost:
 *  `sealPart` (cbsf.ts) holds each part twice — 4 x 4 MiB of sealed frames in
 *  its `body` array plus the concatenated 16 MiB it returns — so ~32 MiB live
 *  per part, ~96 MiB here. Re-measure that before raising it. */
const DEFAULT_PART_CONCURRENCY = 3;

/** Puts one sealed part and returns the provider's ETag. */
export type PartPutter = (input: {
  url: string;
  body: Uint8Array;
  transferId: string;
}) => Promise<string | null>;

/** Network-policy seam (Wi-Fi-only etc.). M1 owns the real policy; false
 *  halts the drain cleanly, leaving every item recoverable. */
export interface UploadPolicy {
  canTransfer: () => boolean | Promise<boolean>;
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
  /** Injected in the suites so a backoff table is asserted, not waited out. */
  now?: () => number;
  random?: () => number;
  /** Same native digest the enqueue used; the edge check must agree with it. */
  createDigest?: () => StreamingDigest;
  /** Progress for the Android foreground-service notification. */
  onProgress?: (progress: DrainProgress) => void;
}

export interface DrainProgress {
  completed: number;
  total: number;
  sha256: string;
}

export interface DrainSummary {
  /** Items that reached `settled` this pass, dedupes INCLUDED once each
   *  (#1014): `settled` used to be incremented alongside `deduped`, so a
   *  100%-dedupe pass reported 200 movements over 100 rows. */
  settled: number;
  failed: number;
  deduped: number;
  /** Items left `pending` behind a backoff window this pass. */
  deferred: number;
  halted: boolean;
}

export class UploadDrainer {
  constructor(private readonly deps: UploadDrainerDeps) {}

  /** One pass over every non-terminal item, oldest first; restart just
   *  calls this — recovery needs no special path. */
  async drainOnce(): Promise<DrainSummary> {
    const summary: DrainSummary = {
      settled: 0,
      failed: 0,
      deduped: 0,
      deferred: 0,
      halted: false,
    };
    /*
     * A LOOP, not recursion (#659) — the same de-recursion the replica SSE
     * stream took, for the same reason: `drainNext(index + 1)` held every
     * earlier item's promise alive until the last one settled, so a deep
     * backlog cost memory proportional to the queue's LENGTH rather than to
     * the item in flight. The queue is read one page at a time for the
     * matching reason. `created_order` is UNIQUE and monotonic, so it doubles
     * as the keyset cursor — a non-terminal failure returns its row to
     * `pending` without rewinding the walk, which is what keeps one failing
     * item from being retried forever inside a single pass.
     */
    const total = this.deps.store.pendingCount();
    let completed = 0;
    let afterOrder = 0;
    for (;;) {
      const page = this.deps.store.pending(
        PENDING_PAGE_LIMIT,
        afterOrder,
        new Date(this.deps.now?.() ?? Date.now()).toISOString()
      );
      if (page.length === 0) return summary;
      for (const item of page) {
        afterOrder = item.createdOrder;
        // oxlint-disable-next-line no-await-in-loop -- re-read per item so a Wi-Fi/charger change halts the drain promptly
        if (!(await this.allowed())) {
          summary.halted = true;
          return summary;
        }
        this.deps.onProgress?.({
          completed,
          total,
          sha256: item.sha256,
        });
        completed += 1;
        try {
          // oxlint-disable-next-line no-await-in-loop -- one item at a time is the point: parallel items would multiply the sealer's transient memory
          const outcome = await this.driveItem(item);
          if (outcome === "deduped") summary.deduped += 1;
          summary.settled += 1;
        } catch (error) {
          if (isKill(error)) throw error;
          summary.deferred += this.recordFailure(item, error, summary);
        }
      }
    }
  }

  /**
   * One item's failure, priced (#1014).
   *
   * TERMINAL only for a refusal that will not fix itself, or after
   * `MAX_ATTEMPTS` spent against a gateway that ANSWERED. A gateway the
   * transport could not reach at all does not spend an attempt — five seconds
   * of aeroplane mode used to burn an item's whole budget and hand the member
   * a permanent failure for a photograph nothing was ever wrong with — but it
   * still takes the backoff, so the drain does not spin on it.
   */
  private recordFailure(
    item: UploadItem,
    error: unknown,
    summary: DrainSummary
  ): number {
    const unreachable = isUnreachable(error);
    if (unreachable) this.deps.store.uncountAttempt(item.itemId);
    const spent = unreachable ? item.attempts : item.attempts + 1;
    const terminal =
      (error instanceof DirectTransferError && error.terminal) ||
      spent >= MAX_ATTEMPTS;
    // The row is member copy (`transfer-failure.ts`); the raw text is
    // the log's alone (#1015 R-NY-10, docs/logs.md).
    this.deps.store.fail(item.itemId, memberTransferFailure(error), terminal);
    console.warn(
      `[centraid] upload: ${item.itemId} was not sent — ${transferFailureDetail(error)}`
    );
    if (terminal) {
      summary.failed += 1;
      return 0;
    }
    const now = this.deps.now?.() ?? Date.now();
    this.deps.store.deferUntil(
      item.itemId,
      new Date(
        now + retryDelayMs(spent, this.deps.random ?? Math.random)
      ).toISOString()
    );
    return 1;
  }

  private async allowed(): Promise<boolean> {
    return (await this.deps.policy?.canTransfer()) ?? true;
  }

  private async driveItem(item: UploadItem): Promise<"settled" | "deduped"> {
    this.deps.store.countAttempt(item.itemId);
    // P4 (#1014): every gateway call for this item is addressed to ITS vault.
    // One queue holds items for several vaults; a client-wide header would
    // stage all of them into whichever vault the gateway picks by default.
    const vaultId = item.targetVaultId;
    const plan = await this.deps.client.begin({
      sha256: item.sha256,
      plaintextSize: item.plaintextSize,
      sealedSize: item.sealedSize,
      partCount: item.partCount,
      ...(item.mediaType ? { mediaType: item.mediaType } : {}),
      ...(item.filename ? { filename: item.filename } : {}),
      ...(vaultId ? { vaultId } : {}),
    });

    // D10: gateway holds these bytes; it is authoritative on durability —
    // persist its receipt verbatim; if none issued (defensive), settle WITHOUT
    // casAck: absent casAck withholds device-original deletion, where a
    // fabricated `replicated` would authorize it.
    if (plan.alreadyPresent) {
      // P22 (#1014): the receipt is the ONLY settled marker, and a fabricated
      // one is a lie about durability. The shipped gateway always issues a
      // settlement alongside `alreadyPresent`; one that did not has told us
      // nothing we may record, so the row stays pending and asks again.
      if (!plan.settlement) {
        throw new Error(
          "gateway reported the bytes present but issued no settlement receipt"
        );
      }
      this.deps.store.settle(item.itemId, plan.settlement);
      return "deduped";
    }
    if (!plan.sessionId || !plan.upload) {
      throw new Error(
        "gateway opened no direct session and reported no existing blob"
      );
    }
    this.deps.store.markBegun(item.itemId, plan.sessionId);

    // The gateway's completedParts are authoritative over local part state.
    for (const part of plan.completedParts) {
      this.deps.store.markPartRecorded(item.itemId, part.partNumber, part.etag);
    }
    this.deps.store.setState(item.itemId, "uploading");

    const key = base64ToBytes(plan.keyBase64);
    if (key.byteLength !== 32)
      throw new Error("gateway returned a malformed content key");

    const urls = new Map<number, string>(
      plan.upload.kind === "single"
        ? [[1, plan.upload.url]]
        : plan.upload.parts.map((part) => [part.partNumber, part.url])
    );
    const directory = await sealDirectory(
      this.deps.crypto,
      key,
      item.sha256,
      item.plaintextSize,
      item.frameCount
    );
    const source = await this.deps.openFile(item.localUri);
    try {
      if (source.size !== item.plaintextSize) {
        // The local file changed under us; its sha no longer addresses it.
        throw new DirectTransferError(
          `local file is ${source.size} bytes, expected ${item.plaintextSize}`,
          400,
          "This file changed on this phone, so it was not sent"
        );
      }
      const outstanding = this.deps.store
        .parts(item.itemId)
        .filter((part) => part.state !== "recorded");
      await this.assertSameFile(item, source);
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

    this.deps.store.setState(item.itemId, "completing");
    const receipts: MultipartPartReceipt[] =
      plan.upload.kind === "multipart"
        ? this.deps.store
            .parts(item.itemId)
            .flatMap((part) =>
              part.etag
                ? [{ partNumber: part.partNumber, etag: part.etag }]
                : []
            )
        : [];
    const receipt: SettlementReceipt = await this.deps.client.complete(
      plan.sessionId,
      receipts,
      vaultId,
      // The follow-up write for this item has not been sent yet (#1014, B5):
      // name it, so the gateway holds the staged bytes until it settles rather
      // than reclaiming them on the 24-hour TTL under a phone that is offline.
      item.itemId
    );
    this.deps.store.settle(item.itemId, receipt);
    return "settled";
  }

  /**
   * The bytes on disk are still the bytes this row addresses (#1014, P22).
   *
   * A resumed multipart upload trusted `size` alone, and a phone that edited a
   * photograph in place — same JPEG dimensions, same byte count, different
   * pixels — then shipped a mixture of the old and new file under the ORIGINAL
   * sha, which is an object whose content does not hash to its own address.
   * The edge digest (first and last MiB, taken at enqueue) catches exactly the
   * in-place rewrite that a size check cannot. Terminal, not retryable: the
   * file is not coming back.
   */
  private async assertSameFile(
    item: UploadItem,
    source: { read: (offset: number, length: number) => Promise<Uint8Array> }
  ): Promise<void> {
    if (!item.edgeDigest) return;
    const seen = await edgeDigestOfFile(
      { size: item.plaintextSize, read: source.read },
      this.deps.createDigest
    );
    if (seen !== item.edgeDigest) {
      throw new DirectTransferError(
        `local file changed under upload ${item.sha256}`,
        400
      );
    }
  }

  private async drainParts(
    item: UploadItem,
    sessionId: string,
    kind: "single" | "multipart",
    ctx: {
      key: Uint8Array;
      directory: Uint8Array;
      urls: Map<number, string>;
      outstanding: { partNumber: number; state: string; etag?: string }[];
      read: (offset: number, length: number) => Promise<Uint8Array>;
    }
  ): Promise<void> {
    const limit =
      kind === "single"
        ? 1
        : (this.deps.partConcurrency ?? DEFAULT_PART_CONCURRENCY);
    await pool(ctx.outstanding, limit, async (part) => {
      // Crash-window replay: bytes are at the provider and the ETag survived;
      // only the gateway receipt did not. Replay the receipt.
      if (part.state === "put" && part.etag) {
        if (kind === "multipart") {
          await this.deps.client.recordPart(
            sessionId,
            part.partNumber,
            part.etag,
            item.targetVaultId
          );
        }
        this.deps.store.markPartRecorded(
          item.itemId,
          part.partNumber,
          part.etag
        );
        return;
      }
      const url = ctx.urls.get(part.partNumber);
      if (!url)
        throw new Error(`gateway minted no URL for part ${part.partNumber}`);

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
      if (kind === "multipart" && !etag) {
        throw new Error("provider did not expose the multipart ETag");
      }
      // Durability ordering: persist the receipt-to-be before asking the
      // gateway to record it.
      this.deps.store.markPartPut(item.itemId, part.partNumber, etag ?? "");
      if (kind === "multipart") {
        await this.deps.client.recordPart(
          sessionId,
          part.partNumber,
          etag!,
          item.targetVaultId
        );
      }
      this.deps.store.markPartRecorded(
        item.itemId,
        part.partNumber,
        etag ?? ""
      );
    });
  }
}

/** Bounded-parallel map that surfaces the first error once all runners stop. */
async function pool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const errors: unknown[] = [];
  const runners = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      const runNext = async (): Promise<void> => {
        const index = cursor++;
        if (index >= items.length || errors.length > 0) return;
        try {
          await work(items[index]!);
        } catch (error) {
          errors.push(error);
          return;
        }
        return runNext();
      };
      return runNext();
    }
  );
  await Promise.all(runners);
  if (errors.length > 0) throw errors[0];
}

/**
 * The transport could not reach the gateway at all — no status, no answer.
 * A `DirectTransferError` always carries the gateway's own status, so it is
 * never this; a `TypeError` from `fetch` (and RN's "Network request failed")
 * is.
 */
function isUnreachable(error: unknown): boolean {
  if (error instanceof DirectTransferError) return false;
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TypeError" ||
    /network request failed|failed to fetch|network error/iu.test(error.message)
  );
}

/** Simulated process death unwinds the whole drain — never retried as a
 *  network error; crash tests rely on it. */
function isKill(error: unknown): boolean {
  return error instanceof Error && error.name === "UploadKillSignalError";
}
