/*
 * Previews-first warm pass (#405): a lazy restore defers every blob the remote
 * CAS holds, so the grid is unusable until the `thumb` rung is local. Pull ALL
 * tinies through `BlobCustody.open` and nothing else — mediums and originals
 * stay remote-only, and full-library materialization is takeout/exportTo.
 */

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EngineLogger } from "@centraid/backup";
import { BlobCustody, FsBlobStore } from "@centraid/vault";
import type { RemoteTier } from "@centraid/vault";

export interface PreviewsWarmResult {
  tiniesTotal: number;
  tiniesWarmed: number;
  /** The remote could not serve these — a degraded grid. */
  tiniesFailed: number;
  /** From `startedAtMs` to the last tiny pulled (§5's metric). */
  timeToUsableGridMs: number;
}

export interface WarmPreviewOptions {
  /** The restored vault directory (`vault.db` + `blobs/` live here). */
  destDir: string;
  /** The SAME remote the lazy restore consulted, so every deferred tiny is
   *  fetchable; its `encryptKey` must match how the objects were sealed. */
  remote: RemoteTier;
  /** Restore-complete wall clock, so the metric is the new-device wait. */
  startedAtMs: number;
  /** Bounded, or it drowns the interactive-read QoS custody enforces. */
  concurrency?: number;
  now?: () => number;
  log?: EngineLogger;
}

const DEFAULT_WARM_CONCURRENCY = 6;

/** Read off the already-WAL-replayed vault.db. Mediums and originals are
 *  deliberately NOT collected — §5 keeps them remote-only. */
function collectThumbShas(destDir: string): string[] {
  const db = new DatabaseSync(path.join(destDir, "vault.db"), {
    readOnly: true,
  });
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT sha256 FROM core_content_derivative
          WHERE variant = 'thumb' AND sha256 IS NOT NULL`
      )
      .all() as { sha256: string }[];
    return rows.map((r) => r.sha256);
  } finally {
    db.close();
  }
}

export async function warmPreviewTinies(
  opts: WarmPreviewOptions
): Promise<PreviewsWarmResult> {
  const now = opts.now ?? (() => Date.now());
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_WARM_CONCURRENCY);
  const shas = collectThumbShas(opts.destDir);

  // No BlobCache: a warm pass bulk-promotes already-durable bytes, so the
  // budget precheck (which guards fresh INGEST) does not apply.
  const custody = new BlobCustody(
    new FsBlobStore(path.join(opts.destDir, "blobs")),
    () => opts.remote
  );

  let warmed = 0;
  let failed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    const i = next++;
    if (i >= shas.length) return;
    const sha = shas[i]!;
    try {
      // Read-through: a hit is a no-op, a miss fetches and promotes.
      const got = await custody.open(sha);
      if (got) warmed += 1;
      else {
        failed += 1;
        opts.log?.warn?.(
          `restore warm-pass: remote CAS has no tiny ${sha} — grid slot degraded`
        );
      }
    } catch (error) {
      failed += 1;
      opts.log?.warn?.(
        `restore warm-pass: tiny ${sha} failed to warm: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return worker();
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, shas.length || 1) }, () =>
      worker()
    )
  );

  const timeToUsableGridMs = now() - opts.startedAtMs;
  opts.log?.info?.(
    `restore warm-pass: ${warmed}/${shas.length} tinies warmed in ${timeToUsableGridMs}ms` +
      (failed > 0 ? ` (${failed} degraded)` : "")
  );
  return {
    tiniesTotal: shas.length,
    tiniesWarmed: warmed,
    tiniesFailed: failed,
    timeToUsableGridMs,
  };
}
