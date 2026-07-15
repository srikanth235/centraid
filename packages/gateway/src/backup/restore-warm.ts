/*
 * Previews-first warm pass (issue #405 §5). After a lazy restore materializes
 * the vault.db + WAL replay and DEFERS every blob the remote CAS already holds
 * (see `backup-service.ts` restore), the grid is only usable once its TINY
 * derivatives — the `thumb` rung — are readable locally. This module pulls ALL
 * of them from the remote tier into the restored spool via the same custody
 * read-through the live vault uses (`BlobCustody.open`), so a fresh device
 * shows a full thumbnail grid in minutes without ever materializing the
 * mediums/originals (those stay remote-only and read-through on demand — the
 * §5 "recents/mediums on demand" contract). Full-library materialization is
 * NOT here: that is the explicit takeout/exportTo path only.
 *
 * The measured cost — time-to-usable-grid (ms from restore-complete to
 * warm-pass-complete) and the count of tinies warmed — rides back in the
 * result so the service/CLI can report how long a new device waits for a
 * usable grid, which is the §5 acceptance metric.
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BlobCustody, FsBlobStore, type RemoteTier } from '@centraid/vault';
import type { EngineLogger } from '@centraid/backup';

export interface PreviewsWarmResult {
  /** Distinct `thumb` shas the restored vault references (the target set). */
  tiniesTotal: number;
  /** Tinies now present in the local spool after the read-through pass. */
  tiniesWarmed: number;
  /** Tinies the remote could not serve (missing/failed) — a degraded grid. */
  tiniesFailed: number;
  /**
   * Time-to-usable-grid (issue #405 §5 acceptance metric): milliseconds from
   * restore-complete (`startedAtMs`) to the moment every tiny had been pulled.
   */
  timeToUsableGridMs: number;
}

export interface WarmPreviewOptions {
  /** The restored vault directory (`vault.db` + `blobs/` live here). */
  destDir: string;
  /**
   * The remote CAS tier to read tinies from — the SAME remote the lazy restore
   * consulted to decide which blobs to defer, so every deferred tiny is
   * fetchable here. Its `encryptKey` must match how the objects were sealed.
   */
  remote: RemoteTier;
  /**
   * Restore-complete wall-clock (from `now()`), so the returned metric measures
   * exactly the new-device wait for a usable grid, not the whole restore.
   */
  startedAtMs: number;
  /** Bounded read-through fan-out. A handful keeps the uplink busy without
   * drowning the interactive-read QoS the custody layer enforces. */
  concurrency?: number;
  now?: () => number;
  log?: EngineLogger;
}

const DEFAULT_WARM_CONCURRENCY = 6;

/** Every DISTINCT `thumb` sha the restored vault references — the tinies whose
 * presence makes the grid usable. Read straight off the restored (already
 * WAL-replayed) vault.db, read-only; mediums/originals are deliberately NOT
 * collected here (issue #405 §5 keeps them remote-only). */
function collectThumbShas(destDir: string): string[] {
  const db = new DatabaseSync(path.join(destDir, 'vault.db'), { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT sha256 FROM core_content_derivative
          WHERE variant = 'thumb' AND sha256 IS NOT NULL`,
      )
      .all() as { sha256: string }[];
    return rows.map((r) => r.sha256);
  } finally {
    db.close();
  }
}

/** Pull the tinies from `remote` into the restored local spool with bounded
 * parallelism, so a fresh device's grid becomes usable without materializing
 * the whole library. Returns the §5 time-to-usable-grid metric. */
export async function warmPreviewTinies(opts: WarmPreviewOptions): Promise<PreviewsWarmResult> {
  const now = opts.now ?? (() => Date.now());
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_WARM_CONCURRENCY);
  const shas = collectThumbShas(opts.destDir);

  // A custody over the restored spool + the injected remote. No BlobCache is
  // wired: a warm pass is a bulk promote of already-durable bytes, so the
  // budget precheck (which guards fresh INGEST) is irrelevant, and `open`'s
  // read-through promotes each tiny into `<destDir>/blobs` on the way through.
  const custody = new BlobCustody(
    new FsBlobStore(path.join(opts.destDir, 'blobs')),
    () => opts.remote,
  );

  let warmed = 0;
  let failed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= shas.length) return;
      const sha = shas[i]!;
      try {
        // Read-through: local hit is a no-op; a miss fetches + promotes locally.
        const got = await custody.open(sha);
        if (got) warmed += 1;
        else {
          failed += 1;
          opts.log?.warn?.(`restore warm-pass: remote CAS has no tiny ${sha} — grid slot degraded`);
        }
      } catch (err) {
        failed += 1;
        opts.log?.warn?.(
          `restore warm-pass: tiny ${sha} failed to warm: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, shas.length || 1) }, () => worker()),
  );

  const timeToUsableGridMs = now() - opts.startedAtMs;
  opts.log?.info?.(
    `restore warm-pass: ${warmed}/${shas.length} tinies warmed in ${timeToUsableGridMs}ms` +
      (failed > 0 ? ` (${failed} degraded)` : ''),
  );
  return {
    tiniesTotal: shas.length,
    tiniesWarmed: warmed,
    tiniesFailed: failed,
    timeToUsableGridMs,
  };
}
