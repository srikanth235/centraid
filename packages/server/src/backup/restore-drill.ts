/*
 * The restore drill's DEPTH half (umbrella #842, slice W1.3).
 *
 * A backup you never restore is not a backup — and a restore you only ever
 * check structurally is barely better. The gateway already runs a REAL restore
 * from the remote into a scratch directory on the vault's `verifyEveryDays`
 * clock (`BackupService.runRestoreVerify`, issue #408 G9) and proves the two
 * files open: `restoreSnapshot` re-derives every chunk id and every entry's
 * capture-time sha, then `verifyRestoredPair` (`@centraid/vault`) runs
 * `integrity_check` / `foreign_key_check`, the G8 receipt cross-check and the
 * #439 R5 seal-key custody verdict.
 *
 * Every one of those checks passes on a restored vault whose CONTENT is gone.
 * `integrity_check` is a statement about b-tree pages, not about rows; a vault
 * that restores with zero content items is a perfectly healthy empty database,
 * and a content row whose blob was never captured is a broken photo that no
 * structural check has an opinion about. This module is the missing half: the
 * checks that ask whether the restored vault is USABLE.
 *
 *   - `restored-blob-coverage`  every blob sha the restored model still claims
 *     (`core_content_item.content_uri`, `core_content_derivative.sha256`) must
 *     be resolvable from the restored vault — present in the restored CAS,
 *     recorded as replicated to the durable remote tier (`blob_replica`, the
 *     bytes a remote-primary snapshot deliberately omits — `backup-sources.ts`
 *     §b), or explicitly held back by a lazy restore's `skipBlob` predicate. A
 *     sha in none of the three is unrecoverable: the row survives the restore
 *     and its bytes do not.
 *   - `restored-census`  the durable content spine (parties, content items,
 *     media assets, consent receipts) must not restore EMPTY out of a source
 *     that holds rows. A snapshot is a point in the past, so the restored
 *     counts are legitimately BEHIND the live ones — but a table that falls
 *     from "has rows" to zero is the empty-shell restore, the exact failure
 *     "a file appeared" describes.
 *   - `cas-rehash` / `replica-journal`  reused verbatim from the doctor
 *     integrity-scrub library (`../doctor`, issue #839 W1.2). The scrub asks
 *     these of a LIVE vault; a restored pair is a vault too, and it is the one
 *     copy nobody has ever opened. They are imported, never reimplemented.
 *
 * The structural half stays where it is. This module runs AFTER
 * `verifyRestoredPair` over the same scratch directory, and the caller folds
 * `error` findings into the run's failure list (health goes red and the
 * failure is PERSISTED into backup state, so the next health probe cannot
 * recompute itself green) and `warning` findings into the degraded branch.
 *
 * Determinism: the CAS sample is drawn from a seed the caller derives from the
 * snapshot being drilled (`<vaultId>:<seq>`), never `Math.random`, so a
 * failing drill re-runs over the identical sample. Nothing here reads a clock.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  FsBlobStore,
  ReplicaIndex,
  checkCasRehash,
  checkReplicaJournalConsistency,
  readBlobStoreSettings,
  shaOfBlobUri,
} from "@centraid/vault";

import type {
  FindingLevel,
  IntegrityCheckName,
  IntegrityFinding,
} from "../doctor/index.js";

/** Failure lines a finding's detail carries before it truncates. */
const MAX_DETAIL_ITEMS = 5;

/** How many restored CAS objects the drill re-hashes when not exhaustive. */
export const DEFAULT_DRILL_CAS_SAMPLE = 64;

export type RestoreDrillCheckName =
  | IntegrityCheckName
  | "restored-blob-coverage"
  | "restored-census";

/** One drill verdict. Shape-compatible with the doctor's `IntegrityFinding`. */
export interface RestoreDrillFinding {
  readonly check: RestoreDrillCheckName;
  readonly level: FindingLevel;
  readonly detail: string;
  readonly target?: string;
}

function finding(
  check: RestoreDrillCheckName,
  level: FindingLevel,
  detail: string,
  target: string
): RestoreDrillFinding {
  return { check, level, detail, target };
}

function preview(values: readonly string[]): string {
  const head = values.slice(0, MAX_DETAIL_ITEMS).map((v) => v.slice(0, 12));
  const rest = values.length - head.length;
  return rest > 0 ? `${head.join(", ")}, +${rest} more` : head.join(", ");
}

// ── deterministic sampling ────────────────────────────────────────────

/**
 * A replayable `[0, 1)` generator seeded from a string (mulberry32 over the
 * first 32 bits of `sha256(seed)`). `Math.random` is banned in this repo: a
 * drill that samples differently on every run cannot be re-run over the
 * sample that failed, and the CI lane could not pin one either.
 */
export function seededRandom(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// ── restored-census ───────────────────────────────────────────────────

/**
 * The durable content spine. Not every table — a generic "count everything"
 * census would flag transient tables (staging rows, drained transfer queues)
 * that legitimately differ between the capture instant and now, and a drill
 * that cries wolf is a drill the owner learns to ignore. These four are the
 * tables whose emptiness means the owner's data is gone.
 */
export interface SpineCensus {
  /** `core_party` — people and orgs. */
  readonly party: number;
  /** `core_content_item` — the content spine. */
  readonly content: number;
  /** `media_asset` — the photo/media rows. */
  readonly media: number;
  /** `consent_receipt` (journal.db) — the audit trail. */
  readonly receipt: number;
}

function countOf(db: DatabaseSync, table: string): number {
  return (
    db.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as { c: number }
  ).c;
}

/** Census one open vault/journal pair — live source or restored copy alike. */
export function spineCensus(
  vault: DatabaseSync,
  journal: DatabaseSync
): SpineCensus {
  return {
    party: countOf(vault, "core_party"),
    content: countOf(vault, "core_content_item"),
    media: countOf(vault, "media_asset"),
    receipt: countOf(journal, "consent_receipt"),
  };
}

const SPINE_KEYS = ["party", "content", "media", "receipt"] as const;

/**
 * A restored spine table that is EMPTY while the source holds rows is the
 * empty-shell restore. Only that cliff is an error: a restored count merely
 * BEHIND the source is the snapshot being a point in the past, which is the
 * whole point of a snapshot.
 *
 * With no source census (the vault's plane is not mounted, so there is nothing
 * to compare against) the check reports a WARNING naming that reason — never a
 * silent pass. A drill that cannot make its comparison must say so.
 */
export function checkRestoredCensus(input: {
  readonly vaultId: string;
  readonly restored: SpineCensus;
  readonly source?: SpineCensus | undefined;
}): RestoreDrillFinding {
  const shown = SPINE_KEYS.map((k) => `${k}=${input.restored[k]}`).join(" ");
  if (!input.source) {
    return finding(
      "restored-census",
      "warning",
      `${input.vaultId}: restored census (${shown}) could not be compared — ` +
        "the source vault's plane is not mounted, so an empty-shell restore " +
        "would go unnoticed this run",
      input.vaultId
    );
  }
  const source = input.source;
  const emptied = SPINE_KEYS.filter(
    (k) => source[k] > 0 && input.restored[k] === 0
  );
  if (emptied.length === 0) {
    return finding(
      "restored-census",
      "ok",
      `${input.vaultId}: restored content spine present (${shown})`,
      input.vaultId
    );
  }
  return finding(
    "restored-census",
    "error",
    `${input.vaultId}: restored vault is an empty shell — ` +
      emptied
        .map((k) => `${k} restored 0 of ${source[k]} live row(s)`)
        .join("; ") +
      "; the databases open and pass every structural check, and the data is gone",
    input.vaultId
  );
}

// ── restored-blob-coverage ────────────────────────────────────────────

/**
 * Every blob sha the model still CLAIMS as durable content. Deliberately
 * narrower than `@centraid/vault`'s `liveBlobShas`, which also returns
 * `blob_staging` rows: staged bytes are a TTL'd ingress buffer that a snapshot
 * has no obligation to carry, and counting them would make the drill red on a
 * perfectly good backup taken mid-ingest.
 */
export function claimedBlobShas(vault: DatabaseSync): Set<string> {
  const claimed = new Set<string>();
  const uris = vault
    .prepare(
      `SELECT content_uri FROM core_content_item WHERE content_uri LIKE 'blob:%'`
    )
    .all() as { content_uri: string }[];
  for (const row of uris) {
    const sha = shaOfBlobUri(row.content_uri);
    if (sha) claimed.add(sha);
  }
  const derived = vault
    .prepare(
      "SELECT sha256 FROM core_content_derivative WHERE sha256 IS NOT NULL"
    )
    .all() as { sha256: string }[];
  for (const row of derived) claimed.add(row.sha256);
  return claimed;
}

export interface BlobCoverageInput {
  readonly vaultId: string;
  /** The RESTORED `vault.db` handle. */
  readonly vault: DatabaseSync;
  /** Shas materialized under the restored `blobs/` CAS. */
  readonly restoredShas: ReadonlySet<string>;
  /** Shas a lazy restore's `skipBlob` predicate deliberately held back. */
  readonly skippedBlobs?: readonly string[] | undefined;
}

/**
 * Prove no restored row points at bytes the restore cannot produce. A claimed
 * sha resolves three ways, and a sha that resolves NONE of them is data the
 * owner has already lost without being told:
 *
 *   1. it is in the restored CAS (the ordinary local-only path — the snapshot
 *      carries the complete resident CAS);
 *   2. the restored vault's own `blob_replica` index records it as replicated
 *      to the durable remote tier, which is exactly the set a remote-primary
 *      snapshot omits on purpose;
 *   3. this restore was lazy and skipped it by predicate.
 *
 * The `blob_replica` evidence is read from the RESTORED vault rather than the
 * live one on purpose: a restore is judged by what the restored bytes alone
 * can prove, not by what the machine that still has the original believes.
 */
export function checkRestoredBlobCoverage(
  input: BlobCoverageInput
): RestoreDrillFinding {
  const claimed = claimedBlobShas(input.vault);
  if (claimed.size === 0) {
    return finding(
      "restored-blob-coverage",
      "ok",
      `${input.vaultId}: restored model claims no blob bytes`,
      input.vaultId
    );
  }
  const remote = new ReplicaIndex(input.vault).all();
  const skipped = new Set(input.skippedBlobs ?? []);
  const missing: string[] = [];
  for (const sha of claimed) {
    if (input.restoredShas.has(sha)) continue;
    if (remote.has(sha)) continue;
    if (skipped.has(sha)) continue;
    missing.push(sha);
  }
  missing.sort();
  const tier = readBlobStoreSettings(input.vault).kind;
  if (missing.length === 0) {
    return finding(
      "restored-blob-coverage",
      "ok",
      `${input.vaultId}: all ${claimed.size} claimed blob(s) resolvable ` +
        `(${input.restoredShas.size} materialized, tier ${tier})`,
      input.vaultId
    );
  }
  return finding(
    "restored-blob-coverage",
    "error",
    `${input.vaultId}: ${missing.length} of ${claimed.size} claimed blob(s) ` +
      `are unrecoverable from this restore — not materialized, not recorded as ` +
      `replicated to the ${tier} tier, and not skipped by a lazy restore ` +
      `(${preview(missing)})`,
    input.vaultId
  );
}

// ── orchestrator ──────────────────────────────────────────────────────

export interface RestoreDrillInput {
  readonly vaultId: string;
  /** The scratch directory `restoreSnapshot` materialized into. */
  readonly destDir: string;
  /**
   * Census of the LIVE source pair, taken by the caller from the mounted
   * plane. Omit only when no plane is mounted — the census check then warns
   * rather than passing.
   */
  readonly sourceCensus?: SpineCensus | undefined;
  /** `RestoreResult.skippedBlobs` from a lazy restore. */
  readonly skippedBlobs?: readonly string[] | undefined;
  /** Replayable sampling seed. Callers pass `<vaultId>:<seq>`. */
  readonly seed: string;
  /** Re-hash every restored CAS object instead of a seeded sample. */
  readonly full?: boolean | undefined;
  readonly casSampleSize?: number | undefined;
}

/**
 * Run every depth check over a freshly restored scratch pair, in a fixed
 * order, and return one flat finding list. Opens the restored databases
 * READ-ONLY and always closes them: the caller deletes this directory next,
 * and an open handle would race the teardown on Windows.
 *
 * A restored pair too damaged to open is not a thrown exception here — it is
 * one `database-integrity` error finding, so the caller reports every problem
 * it found rather than only the first.
 */
export function runRestoreDrill(
  input: RestoreDrillInput
): RestoreDrillFinding[] {
  let vault: DatabaseSync;
  let journal: DatabaseSync;
  try {
    vault = new DatabaseSync(path.join(input.destDir, "vault.db"), {
      readOnly: true,
    });
    journal = new DatabaseSync(path.join(input.destDir, "journal.db"), {
      readOnly: true,
    });
  } catch (error) {
    return [
      finding(
        "database-integrity",
        "error",
        `${input.vaultId}: the restored pair could not be opened — ` +
          (error instanceof Error ? error.message : String(error)),
        input.vaultId
      ),
    ];
  }
  try {
    const local = new FsBlobStore(path.join(input.destDir, "blobs"));
    const restoredShas = new Set(local.listSync());
    const findings: RestoreDrillFinding[] = [
      checkRestoredCensus({
        vaultId: input.vaultId,
        restored: spineCensus(vault, journal),
        source: input.sourceCensus,
      }),
      checkRestoredBlobCoverage({
        vaultId: input.vaultId,
        vault,
        restoredShas,
        skippedBlobs: input.skippedBlobs,
      }),
      // Reused from the doctor scrub — the restored CAS is a CAS, and this is
      // the one copy of it nobody has ever opened.
      widen(
        checkCasRehash({
          vaultId: input.vaultId,
          local,
          full: input.full ?? false,
          sampleSize: input.casSampleSize ?? DEFAULT_DRILL_CAS_SAMPLE,
          random: seededRandom(input.seed),
        })
      ),
      widen(
        checkReplicaJournalConsistency({
          vaultId: input.vaultId,
          vault,
          journal,
        })
      ),
    ];
    return findings;
  } finally {
    vault.close();
    journal.close();
  }
}

/** An `IntegrityFinding` is already a valid drill finding; name the widening. */
function widen(found: IntegrityFinding): RestoreDrillFinding {
  return found;
}

/** The drill's failure list — details of every `error` finding, in order. */
export function drillErrors(
  findings: readonly RestoreDrillFinding[]
): string[] {
  return findings.filter((f) => f.level === "error").map((f) => f.detail);
}

/** The drill's degrade list — details of every `warning` finding, in order. */
export function drillWarnings(
  findings: readonly RestoreDrillFinding[]
): string[] {
  return findings.filter((f) => f.level === "warning").map((f) => f.detail);
}
