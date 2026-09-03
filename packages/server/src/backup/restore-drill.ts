import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  FsBlobStore,
  ReplicaIndex,
  readBlobStoreSettings,
  shaOfBlobUri,
} from "@centraid/vault";

import {
  checkCasRehash,
  checkReplicaJournalConsistency,
} from "../doctor/index.js";
import type {
  FindingLevel,
  IntegrityCheckName,
  IntegrityFinding,
} from "../doctor/index.js";

const MAX_DETAIL_ITEMS = 5;

export const DEFAULT_DRILL_CAS_SAMPLE = 64;

export type RestoreDrillCheckName =
  | IntegrityCheckName
  | "restored-blob-coverage"
  | "restored-census";

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

export interface SpineCensus {
  readonly party: number;
  readonly content: number;
  readonly media: number;
  readonly receipt: number;
}

function countOf(db: DatabaseSync, table: string): number {
  return (
    db.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as { c: number }
  ).c;
}

export function spineCensus(vault: DatabaseSync): SpineCensus {
  return {
    party: countOf(vault, "core_party"),
    content: countOf(vault, "core_content_item"),
    media: countOf(vault, "media_asset"),
    receipt: countOf(vault, "access_receipt"),
  };
}

const SPINE_KEYS = ["party", "content", "media", "receipt"] as const;

export function checkRestoredCensus(input: {
  readonly vaultId: string;
  readonly restored: SpineCensus;
  readonly source?: SpineCensus | undefined;
}): RestoreDrillFinding {
  const shown = SPINE_KEYS.map((k) => `${k}=${input.restored[k]}`).join(" ");
  if (input.restored.party === 0) {
    return finding(
      "restored-census",
      "error",
      `${input.vaultId}: restored vault is an EMPTY SHELL (${shown}) — ` +
        "founding enrolls the owner party, so a founded vault is never " +
        "partyless at any instant a snapshot could capture; these two " +
        "databases open, pass every structural check, and hold nobody",
      input.vaultId
    );
  }
  if (!input.source) {
    return finding(
      "restored-census",
      "warning",
      `${input.vaultId}: restored census (${shown}) could not be compared — ` +
        "the source vault's plane is not mounted, so a spine table that " +
        "restored empty would go unnoticed this run",
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
    "warning",
    `${input.vaultId}: ` +
      emptied
        .map((k) => `${k} restored 0 of ${source[k]} live row(s)`)
        .join("; ") +
      " — a snapshot older than the rows explains this; anything else needs eyes",
    input.vaultId
  );
}

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
  readonly vault: DatabaseSync;
  readonly restoredShas: ReadonlySet<string>;
  readonly skippedBlobs?: readonly string[] | undefined;
}

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
  const skipped = new Set<string>(input.skippedBlobs);
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

export interface RestoreDrillInput {
  readonly vaultId: string;
  readonly destDir: string;
  readonly sourceCensus?: SpineCensus | undefined;
  readonly skippedBlobs?: readonly string[] | undefined;
  readonly seed: string;
  readonly full?: boolean | undefined;
  readonly casSampleSize?: number | undefined;
}

export function runRestoreDrill(
  input: RestoreDrillInput
): RestoreDrillFinding[] {
  let vault: DatabaseSync;
  try {
    vault = new DatabaseSync(path.join(input.destDir, "vault.db"), {
      readOnly: true,
    });
  } catch (error) {
    return [
      finding(
        "database-integrity",
        "error",
        `${input.vaultId}: the restored vault could not be opened — ` +
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
        restored: spineCensus(vault),
        source: input.sourceCensus,
      }),
      checkRestoredBlobCoverage({
        vaultId: input.vaultId,
        vault,
        restoredShas,
        skippedBlobs: input.skippedBlobs,
      }),
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
        })
      ),
    ];
    return findings;
  } finally {
    vault.close();
  }
}

function widen(found: IntegrityFinding): RestoreDrillFinding {
  return found;
}

export function drillErrors(
  findings: readonly RestoreDrillFinding[]
): string[] {
  return findings.filter((f) => f.level === "error").map((f) => f.detail);
}

export function drillWarnings(
  findings: readonly RestoreDrillFinding[]
): string[] {
  return findings.filter((f) => f.level === "warning").map((f) => f.detail);
}
