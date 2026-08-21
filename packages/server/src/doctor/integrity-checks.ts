/*
 * The in-product integrity scrub check library (issue #839 W1.2).
 *
 * A reusable set of invariant checks over the databases and content-addressed
 * store a gateway owns, plus one orchestrator that runs them all. The
 * `centraid-gateway doctor` verb (`../cli/doctor.ts`) is the first caller; the
 * scheduled background scrub (W1.2 second half) and the crash lane (W1.1) are
 * meant to import the SAME check functions rather than reimplement the
 * invariants — so every check here is a pure function over an already-open
 * handle (or a CAS directory), returns a structured `IntegrityFinding`, and
 * touches no product state.
 *
 * What each check proves:
 *   - `database-integrity`  `PRAGMA integrity_check` on every db the gateway
 *      owns (each vault's `vault.db` + `journal.db`, and `gateway.db`). The
 *      exhaustive cousin of the `vault-integrity` health probe's `quick_check`
 *      (`../serve/vault-integrity-health.ts`) — a scrub is not a per-tick read,
 *      so it pays for the UNIQUE-constraint verification `quick_check` skips.
 *   - `cas-rehash`  re-hashes CAS blobs against their content address. The
 *      local tier is content-addressed by the sha256 of the bytes on disk
 *      (`@centraid/vault` `FsBlobStore`), so `sha256(getSync(sha)) === sha` is
 *      the exact write-once invariant. Sampled by default; `full` re-hashes
 *      every object.
 *   - `hardlink-refcount`  audits the cross-vault GC contract (issue #599
 *      decision 11): share-by-placement hardlinks a blob into a second vault's
 *      CAS, so "the filesystem's link count is the cross-vault refcount". A
 *      blob's `st_nlink` must therefore equal the number of CAS directory
 *      entries the gateway's own vaults hold for that inode — a higher count is
 *      an unaccounted external link whose bytes no vault's sweep can ever free.
 *   - `replica-journal`  checks the replica change-log (the vault's replication
 *      journal, `replica_change` in `vault.db`) against its own meta and the
 *      audit journal (`journal.db`): no row survives from a foreign epoch (the
 *      retention prune deletes `epoch <> current`), no commit group is left
 *      marked active at rest, the autoincrement watermark never rewound below
 *      the max change seq, and `journal.db` still answers.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { currentReplicaLogState } from "@centraid/vault";
import type { LocalBlobStore } from "@centraid/vault";

/** How many CAS objects a sampled `cas-rehash` re-hashes when not `full`. */
export const DEFAULT_CAS_SAMPLE_SIZE = 128;
/** Failure lines surfaced in a finding's detail before it truncates. */
const MAX_DETAIL_LINES = 5;

export type FindingLevel = "ok" | "warning" | "error";

export type IntegrityCheckName =
  | "database-integrity"
  | "cas-rehash"
  | "hardlink-refcount"
  | "replica-journal";

/** One check's verdict over one target: level + human detail. */
export interface IntegrityFinding {
  readonly check: IntegrityCheckName;
  readonly level: FindingLevel;
  readonly detail: string;
  /** The db label or vault id this finding is about, when scoped to one. */
  readonly target?: string;
}

function finding(
  check: IntegrityCheckName,
  level: FindingLevel,
  detail: string,
  target?: string
): IntegrityFinding {
  return target === undefined
    ? { check, level, detail }
    : { check, level, detail, target };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── database-integrity ────────────────────────────────────────────────

/** A named open SQLite handle for the `database-integrity` check. */
export interface DatabaseTarget {
  readonly label: string;
  readonly db: DatabaseSync;
}

/**
 * `PRAGMA integrity_check` on one handle. `ok` iff the sole result row is
 * literally `'ok'`; anything else (violation lines, or a throw from a handle
 * too corrupt to answer) is an error.
 */
export function checkDatabaseIntegrity(
  target: DatabaseTarget
): IntegrityFinding {
  try {
    const rows = target.db.prepare("PRAGMA integrity_check").all() as {
      integrity_check: string;
    }[];
    if (rows.length === 1 && rows[0]?.integrity_check === "ok") {
      return finding(
        "database-integrity",
        "ok",
        `${target.label}: integrity_check ok`,
        target.label
      );
    }
    const lines = rows
      .slice(0, MAX_DETAIL_LINES)
      .map((row) => row.integrity_check)
      .join("; ");
    return finding(
      "database-integrity",
      "error",
      `${target.label}: integrity_check failed — ${lines}`,
      target.label
    );
  } catch (error) {
    return finding(
      "database-integrity",
      "error",
      `${target.label}: integrity_check could not run — ${messageOf(error)}`,
      target.label
    );
  }
}

// ── cas-rehash ────────────────────────────────────────────────────────

export interface CasRehashInput {
  readonly vaultId: string;
  readonly local: Pick<LocalBlobStore, "listSync" | "getSync">;
  /** Re-hash every object instead of a bounded random sample. */
  readonly full?: boolean;
  /** Sampled-mode cap. Defaults to `DEFAULT_CAS_SAMPLE_SIZE`. */
  readonly sampleSize?: number;
  /** RNG seam (tests) returning `[0, 1)`. Defaults to `Math.random`. */
  readonly random?: () => number;
}

/** A bounded random subset of `all` (Fisher–Yates prefix over a copy). */
function sample(all: string[], size: number, random: () => number): string[] {
  const pool = [...all];
  const take = Math.min(size, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    const swap = pool[j] as string;
    pool[j] = pool[i] as string;
    pool[i] = swap;
  }
  return pool.slice(0, take);
}

/**
 * Re-hash CAS objects against their content address. A listed object that will
 * not read back, or whose bytes hash to something other than their key, is a
 * corrupt blob — a silent bit-rot the address was chosen to catch.
 */
export function checkCasRehash(input: CasRehashInput): IntegrityFinding {
  const all = input.local.listSync();
  if (all.length === 0) {
    return finding(
      "cas-rehash",
      "ok",
      `${input.vaultId}: CAS is empty`,
      input.vaultId
    );
  }
  const size = input.sampleSize ?? DEFAULT_CAS_SAMPLE_SIZE;
  const selected =
    input.full || all.length <= size
      ? all
      : sample(all, size, input.random ?? Math.random);
  const mismatched: string[] = [];
  const unreadable: string[] = [];
  for (const sha of selected) {
    const bytes = input.local.getSync(sha);
    if (bytes === null) {
      unreadable.push(sha);
      continue;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== sha) {
      mismatched.push(sha);
    }
  }
  const scope =
    selected.length === all.length
      ? `all ${all.length}`
      : `${selected.length} of ${all.length} sampled`;
  if (mismatched.length === 0 && unreadable.length === 0) {
    return finding(
      "cas-rehash",
      "ok",
      `${input.vaultId}: ${scope} CAS object(s) re-hash to their address`,
      input.vaultId
    );
  }
  const parts: string[] = [];
  if (mismatched.length > 0) {
    parts.push(
      `${mismatched.length} hash mismatch (${mismatched
        .slice(0, MAX_DETAIL_LINES)
        .map((sha) => sha.slice(0, 12))
        .join(", ")})`
    );
  }
  if (unreadable.length > 0) {
    parts.push(
      `${unreadable.length} listed but unreadable (${unreadable
        .slice(0, MAX_DETAIL_LINES)
        .map((sha) => sha.slice(0, 12))
        .join(", ")})`
    );
  }
  return finding(
    "cas-rehash",
    "error",
    `${input.vaultId}: ${scope} — ${parts.join("; ")}`,
    input.vaultId
  );
}

// ── hardlink-refcount ─────────────────────────────────────────────────

/** One vault's blob directory (`<vault-dir>/blobs`) for the refcount audit. */
export interface VaultCasRoot {
  readonly vaultId: string;
  /** The vault's `blobs/` directory; the audit walks `blobs/sha256/`. */
  readonly casRoot: string;
}

interface InodeRecord {
  nlink: number;
  paths: string[];
}

/**
 * Audit the cross-vault GC contract: every CAS blob's on-disk link count must
 * equal the number of CAS directory entries the passed-in vaults hold for its
 * inode. A higher `st_nlink` means a directory entry OUTSIDE the gateway's own
 * vaults also points at those bytes — an unaccounted link no vault's sweep can
 * ever unlink, so the bytes leak forever (the refcount can never reach zero).
 *
 * Cross-vault by construction: it collects every owned vault's entries first,
 * keyed by `dev:ino`, so a blob legitimately shared across two vaults (two
 * entries, `st_nlink === 2`) reconciles rather than looking like a leak.
 */
export function checkHardlinkRefcounts(
  vaults: readonly VaultCasRoot[]
): IntegrityFinding {
  const inodes = new Map<string, InodeRecord>();
  for (const vault of vaults) {
    const base = path.join(vault.casRoot, "sha256");
    if (!existsSync(base)) continue;
    for (const fan of readdirSync(base)) {
      let entries: string[];
      try {
        entries = readdirSync(path.join(base, fan));
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!/^[0-9a-f]{64}$/u.test(name)) continue;
        const file = path.join(base, fan, name);
        let stat;
        try {
          stat = statSync(file);
        } catch {
          continue;
        }
        const key = `${stat.dev}:${stat.ino}`;
        const record = inodes.get(key) ?? { nlink: stat.nlink, paths: [] };
        record.nlink = stat.nlink;
        record.paths.push(file);
        inodes.set(key, record);
      }
    }
  }
  const violations: string[] = [];
  for (const [key, record] of inodes) {
    if (record.nlink !== record.paths.length) {
      violations.push(
        `inode ${key}: link count ${record.nlink} != ${record.paths.length} ` +
          `CAS entr${record.paths.length === 1 ? "y" : "ies"} across owned vaults`
      );
    }
  }
  if (violations.length === 0) {
    return finding(
      "hardlink-refcount",
      "ok",
      `${inodes.size} CAS inode(s) across ${vaults.length} vault(s) match their cross-vault refcount`
    );
  }
  return finding(
    "hardlink-refcount",
    "error",
    `${violations.length} refcount violation(s): ${violations
      .slice(0, MAX_DETAIL_LINES)
      .join(" | ")}`
  );
}

// ── replica-journal ───────────────────────────────────────────────────

export interface ReplicaJournalInput {
  readonly vaultId: string;
  readonly vault: DatabaseSync;
  readonly journal: DatabaseSync;
}

/**
 * Check the replica change-log (the vault's replication journal) against its
 * own meta and the audit journal. Every violation here is a state the log's
 * own writers make unrepresentable, so observing one is corruption.
 */
export function checkReplicaJournalConsistency(
  input: ReplicaJournalInput
): IntegrityFinding {
  let state;
  try {
    state = currentReplicaLogState(input.vault);
  } catch (error) {
    return finding(
      "replica-journal",
      "error",
      `${input.vaultId}: replica metadata unreadable — ${messageOf(error)}`,
      input.vaultId
    );
  }
  const problems: string[] = [];

  const foreign = (
    input.vault
      .prepare("SELECT COUNT(*) AS n FROM replica_change WHERE epoch <> ?")
      .get(state.epoch) as { n: number }
  ).n;
  if (foreign > 0) {
    problems.push(
      `${foreign} replica_change row(s) survive from a foreign epoch (retention deletes epoch <> current)`
    );
  }

  const active = (
    input.vault
      .prepare("SELECT active_commit_id FROM replica_meta WHERE singleton = 1")
      .get() as { active_commit_id: string | null } | undefined
  )?.active_commit_id;
  if (active) {
    problems.push(
      `commit group ${active} is still marked active at rest — a crash left a write window open`
    );
  }

  const seqRow = input.vault
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'replica_change'")
    .get() as { seq: number } | undefined;
  const maxSeq = (
    input.vault
      .prepare("SELECT MAX(seq) AS m FROM replica_change WHERE epoch = ?")
      .get(state.epoch) as { m: number | null }
  ).m;
  if (maxSeq !== null && (seqRow?.seq ?? 0) < maxSeq) {
    problems.push(
      `autoincrement watermark ${seqRow?.seq ?? 0} rewound below max change seq ${maxSeq}`
    );
  }

  try {
    input.journal.prepare("SELECT COUNT(*) AS n FROM consent_receipt").get();
  } catch (error) {
    problems.push(`journal.db audit trail unreadable — ${messageOf(error)}`);
  }

  if (problems.length === 0) {
    return finding(
      "replica-journal",
      "ok",
      `${input.vaultId}: change-log consistent (epoch ${state.epoch.slice(0, 8)}, floor ${state.floor.seq} <= watermark ${state.watermark.seq})`,
      input.vaultId
    );
  }
  return finding(
    "replica-journal",
    "error",
    `${input.vaultId}: ${problems.join("; ")}`,
    input.vaultId
  );
}

// ── orchestrator ──────────────────────────────────────────────────────

/** One vault's open handles + CAS location for the full scrub. */
export interface DoctorVaultTarget {
  readonly vaultId: string;
  readonly vault: DatabaseSync;
  readonly journal: DatabaseSync;
  readonly local: Pick<LocalBlobStore, "listSync" | "getSync">;
  /** The vault's `blobs/` directory (for the cross-vault refcount audit). */
  readonly casRoot: string;
}

export interface IntegrityScrubInput {
  readonly vaults: readonly DoctorVaultTarget[];
  /** Extra owned databases to integrity-check, e.g. `gateway.db`. */
  readonly extraDatabases?: readonly DatabaseTarget[];
  /** Re-hash every CAS object rather than a sample. */
  readonly full?: boolean;
  readonly sampleSize?: number;
  readonly random?: () => number;
}

/**
 * Run every invariant check across the owned databases and vaults, returning
 * one flat list of findings. Deterministic order: extra databases, then per
 * vault (integrity of both files, CAS re-hash, replica/journal), then the one
 * cross-vault hardlink-refcount audit last.
 */
export function runIntegrityScrub(
  input: IntegrityScrubInput
): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  for (const extra of input.extraDatabases ?? []) {
    findings.push(checkDatabaseIntegrity(extra));
  }
  for (const vault of input.vaults) {
    findings.push(
      checkDatabaseIntegrity({
        label: `${vault.vaultId}/vault.db`,
        db: vault.vault,
      }),
      checkDatabaseIntegrity({
        label: `${vault.vaultId}/journal.db`,
        db: vault.journal,
      }),
      checkCasRehash({
        vaultId: vault.vaultId,
        local: vault.local,
        ...(input.full === undefined ? {} : { full: input.full }),
        ...(input.sampleSize === undefined
          ? {}
          : { sampleSize: input.sampleSize }),
        ...(input.random === undefined ? {} : { random: input.random }),
      }),
      checkReplicaJournalConsistency({
        vaultId: vault.vaultId,
        vault: vault.vault,
        journal: vault.journal,
      })
    );
  }
  findings.push(
    checkHardlinkRefcounts(
      input.vaults.map((vault) => ({
        vaultId: vault.vaultId,
        casRoot: vault.casRoot,
      }))
    )
  );
  return findings;
}

/** True when any finding is an error — the scrub's nonzero-exit condition. */
export function hasError(findings: readonly IntegrityFinding[]): boolean {
  return findings.some((f) => f.level === "error");
}

/** True when any finding is a warning (and none is an error). */
export function hasWarning(findings: readonly IntegrityFinding[]): boolean {
  return findings.some((f) => f.level === "warning");
}
