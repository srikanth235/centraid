import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EngineLogger } from "@centraid/backup";
import { BlobCustody, FsBlobStore } from "@centraid/vault";
import type { RemoteTier } from "@centraid/vault";

export interface PreviewsWarmResult {
  tiniesTotal: number;
  tiniesWarmed: number;
  tiniesFailed: number;
  timeToUsableGridMs: number;
}

export interface WarmPreviewOptions {
  destDir: string;
  remote: RemoteTier;
  startedAtMs: number;
  concurrency?: number;
  now?: () => number;
  log?: EngineLogger;
}

const DEFAULT_WARM_CONCURRENCY = 6;

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
