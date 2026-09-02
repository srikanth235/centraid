/*
 * `vault doctor` — the structural invariant sweep over a LIVE vault (#892).
 *
 * `restore-check.ts` answers "is this directory a sound restore?"; this answers
 * "is this vault internally consistent right now?" over an already-open handle, so
 * it can ride at the end of any harness that touched a vault. That is what turns
 * the existing suite into a data-corruption detector.
 *
 * Three classes. `integrity` and `foreign-keys` are what SQLite knows about —
 * and since the entity supertype landed (#916) that is EVERY pointer: the
 * polymorphic `(target_type, target_id)` pairs the old sweep had to walk by
 * hand are composite foreign keys into `core_entity`, so `PRAGMA
 * foreign_key_check` is the check and a hand-written registry walk could only
 * disagree with the engine. `blobs` catches custody rows naming content with
 * no location.
 *
 * Findings carry a count and a sample, never rows: this ends up in CI logs.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DoctorClass = "integrity" | "foreign-keys" | "blobs";

export interface DoctorFinding {
  class: DoctorClass;
  /** One line naming the invariant that does not hold. */
  detail: string;
  /** How many rows are implicated. */
  count: number;
  /** At most a handful of opaque ids, for the person who has to go looking. */
  sample: string[];
}

export interface DoctorReport {
  ok: boolean;
  findings: DoctorFinding[];
  /** What was actually looked at, so a vacuous pass is visible as one. */
  checked: {
    foreignKeys: number;
    tablesWithBlobRefs: number;
  };
}

const SAMPLE_LIMIT = 5;

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`
    )
    .get(table);
  return row !== undefined;
}

function checkIntegrity(db: DatabaseSync): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const integrity = db.prepare("PRAGMA integrity_check").get() as
    | { integrity_check?: string }
    | undefined;
  const verdict = integrity?.integrity_check ?? "no result";
  if (verdict !== "ok") {
    findings.push({
      class: "integrity",
      detail: `PRAGMA integrity_check returned "${verdict}"`,
      count: 1,
      sample: [],
    });
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all() as {
    table?: string;
  }[];
  if (violations.length > 0) {
    findings.push({
      class: "foreign-keys",
      detail: "PRAGMA foreign_key_check reported violations",
      count: violations.length,
      sample: [
        ...new Set(violations.map((row) => String(row.table ?? "?"))),
      ].slice(0, SAMPLE_LIMIT),
    });
  }
  return findings;
}

/** How many real foreign keys the engine was asked about, so a vacuous pass
 * is visible as one. */
function foreignKeyCount(vault: DatabaseSync): number {
  const tables = vault
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as { name: string }[];
  let total = 0;
  for (const table of tables) {
    total += vault
      .prepare(`PRAGMA foreign_key_list("${table.name}")`)
      .all().length;
  }
  return total;
}

/**
 * Blob custody accounting. A `blob_custody_state` row whose hash has no
 * `blob_replica` row is a vault claiming content it has no location for — what a
 * member experiences as a file that will not open.
 */
function checkBlobs(vault: DatabaseSync): {
  findings: DoctorFinding[];
  tables: number;
} {
  const findings: DoctorFinding[] = [];
  let tables = 0;
  if (
    !tableExists(vault, "blob_custody_state") ||
    !tableExists(vault, "blob_replica")
  ) {
    return { findings, tables };
  }
  tables = 2;
  const hashColumn = (table: string): string | undefined => {
    const cols = vault.prepare(`PRAGMA table_info("${table}")`).all() as {
      name: string;
    }[];
    return cols.find((column) => /hash|digest|blob_id/u.test(column.name))
      ?.name;
  };
  const custodyKey = hashColumn("blob_custody_state");
  const replicaKey = hashColumn("blob_replica");
  if (!custodyKey || !replicaKey) return { findings, tables };
  const orphans = vault
    .prepare(
      `SELECT c."${custodyKey}" AS h
         FROM "blob_custody_state" c
    LEFT JOIN "blob_replica" r ON r."${replicaKey}" = c."${custodyKey}"
        WHERE r."${replicaKey}" IS NULL`
    )
    .all() as { h: string }[];
  if (orphans.length > 0) {
    findings.push({
      class: "blobs",
      detail:
        "blob_custody_state names content with no blob_replica row — the vault claims custody of bytes it has no location for",
      count: orphans.length,
      sample: orphans.slice(0, SAMPLE_LIMIT).map((row) => String(row.h)),
    });
  }
  return { findings, tables };
}

/** Read-only by construction — every statement is a `PRAGMA` or a `SELECT`. */
export function vaultDoctor(pair: { vault: DatabaseSync }): DoctorReport {
  const findings: DoctorFinding[] = [...checkIntegrity(pair.vault)];
  const blobs = checkBlobs(pair.vault);
  findings.push(...blobs.findings);
  return {
    ok: findings.length === 0,
    findings,
    checked: {
      foreignKeys: foreignKeyCount(pair.vault),
      tablesWithBlobRefs: blobs.tables,
    },
  };
}

/** The report as one readable block, for a CI log or a thrown error. */
export function formatDoctorReport(report: DoctorReport): string {
  if (report.ok) {
    return (
      `vault doctor: clean — ${report.checked.foreignKeys} foreign key(s) ` +
      `and ${report.checked.tablesWithBlobRefs} blob table(s) checked`
    );
  }
  const lines = [`vault doctor: ${report.findings.length} finding(s)`];
  for (const finding of report.findings) {
    lines.push(
      `  [${finding.class}] ${finding.detail} (${finding.count})` +
        (finding.sample.length ? ` e.g. ${finding.sample.join(", ")}` : "")
    );
  }
  return lines.join("\n");
}

/**
 * Throw unless the vault is sound. A sweep whose report nobody reads is a slower
 * no-op, so the harness-facing entry point is the one that fails.
 */
export function assertVaultHealthy(pair: {
  vault: DatabaseSync;
}): DoctorReport {
  const report = vaultDoctor(pair);
  if (!report.ok) throw new Error(formatDoctorReport(report));
  return report;
}

/** Every directory under a root that holds a `vault.db`. */
function vaultPairsUnder(root: string, depth = 4): string[] {
  if (depth < 0 || !existsSync(root)) return [];
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...vaultPairsUnder(full, depth - 1));
    else if (entry.name === "vault.db") found.push(root);
  }
  return found;
}

/** Open one vault read-only and run the sweep over it. */
function inspectVaultDir(dir: string): DoctorReport {
  const vault = new DatabaseSync(path.join(dir, "vault.db"), {
    readOnly: true,
  });
  try {
    return vaultDoctor({ vault });
  } finally {
    vault.close();
  }
}

/**
 * Sweep every vault under a tree and throw when any is unhealthy — the
 * harness-facing entry point (#892). Opened `readOnly` and AFTER the gateway has
 * closed: a doctor that migrated the vault it inspected would measure its own
 * effect. Returns the dirs it checked, so a vacuous zero is visible.
 */
export function assertVaultTreeHealthy(root: string): {
  checked: string[];
  reports: DoctorReport[];
} {
  const dirs = vaultPairsUnder(root);
  // Sweep EVERY vault before deciding, rather than throwing on the first bad
  // one: a host with several vaults mounted wants the whole picture, and a
  // report that stops at the first finding hides the ones behind it.
  const swept = dirs.map((dir) => ({ dir, report: inspectVaultDir(dir) }));
  const unhealthy = swept.filter((entry) => !entry.report.ok);
  if (unhealthy.length > 0) {
    throw new Error(
      unhealthy
        .map((entry) => `${entry.dir}\n${formatDoctorReport(entry.report)}`)
        .join("\n\n")
    );
  }
  return { checked: dirs, reports: swept.map((entry) => entry.report) };
}
