/*
 * Integrity scrub checks (#839). Keep every check a pure function over an
 * already-open handle (or a CAS directory) returning an `IntegrityFinding` and
 * touching no product state: the doctor verb, the scheduled scrub, and the
 * crash lane all import these rather than reimplement the invariants.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { currentReplicaLogState } from "@centraid/vault";
import type { LocalBlobStore } from "@centraid/vault";

export const DEFAULT_CAS_SAMPLE_SIZE = 128;
const MAX_DETAIL_LINES = 5;

export type FindingLevel = "ok" | "warning" | "error";

export type IntegrityCheckName =
  | "database-integrity"
  | "cas-rehash"
  | "hardlink-refcount"
  | "replica-journal";

export interface IntegrityFinding {
  readonly check: IntegrityCheckName;
  readonly level: FindingLevel;
  readonly detail: string;
  /** Db label or vault id, when the finding is scoped to one. */
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

// ─── database-integrity ───

export interface DatabaseTarget {
  readonly label: string;
  readonly db: DatabaseSync;
}

/** Full check, not the health probe's `quick_check`: pays for UNIQUE verify. */
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

// ─── cas-rehash ───

export interface CasRehashInput {
  readonly vaultId: string;
  readonly local: Pick<LocalBlobStore, "listSync" | "getSync">;
  readonly full?: boolean;
  /** Defaults to `DEFAULT_CAS_SAMPLE_SIZE`. */
  readonly sampleSize?: number;
  /** RNG seam (tests) returning `[0, 1)`. Defaults to `Math.random`. */
  readonly random?: () => number;
}

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

/** `sha256(getSync(sha)) === sha`; a mis-hash or unreadable listing is rot. */
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

// ─── hardlink-refcount ───

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
 * Link count IS the cross-vault refcount (#599 decision 11): a blob's `st_nlink`
 * above its CAS entries across owned vaults is an outside link, so the refcount
 * never reaches zero. Collect all vaults first — sharing is not a leak.
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

// ─── replica-journal ───

export interface ReplicaJournalInput {
  readonly vaultId: string;
  readonly vault: DatabaseSync;
  readonly journal: DatabaseSync;
}

/** Every violation here is a state the log's writers make unrepresentable. */
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

// ─── orchestrator ───

export interface DoctorVaultTarget {
  readonly vaultId: string;
  readonly vault: DatabaseSync;
  readonly journal: DatabaseSync;
  readonly local: Pick<LocalBlobStore, "listSync" | "getSync">;
  readonly casRoot: string;
}

export interface IntegrityScrubInput {
  readonly vaults: readonly DoctorVaultTarget[];
  /** Extra owned databases to integrity-check, e.g. `gateway.db`. */
  readonly extraDatabases?: readonly DatabaseTarget[];
  readonly full?: boolean;
  readonly sampleSize?: number;
  readonly random?: () => number;
}

/** Order is a contract: extra dbs, then per vault, then the refcount audit. */
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

export function hasError(findings: readonly IntegrityFinding[]): boolean {
  return findings.some((f) => f.level === "error");
}
