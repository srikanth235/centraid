/*
 * `vault doctor` — the structural invariant sweep over a LIVE vault (#892).
 *
 * `restore-check.ts` answers "is this directory a sound restore?"; this answers
 * "is this vault internally consistent right now?" over an already-open pair, so
 * it can ride at the end of any harness that touched a vault. That is what turns
 * the existing suite into a data-corruption detector.
 *
 * Four classes. `integrity` and `foreign-keys` are the references SQLite knows
 * about. `poly-refs` are the ones it does not: a `(target_type, target_id)` pair
 * is a logical FK #441 had to sweep by hand, and hand-swept means missable — an
 * orphan vector resurfaces deleted content in search. It walks the same registry
 * the purge does, so the two can never disagree about the set. `blobs` catches
 * custody rows naming content with no location.
 *
 * Findings carry a count and a sample, never rows: this ends up in CI logs.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { POLY_REF_REGISTRY } from "./schema/poly-refs.js";
import { resolveEntity } from "./schema/tables.js";

export type DoctorClass = "integrity" | "foreign-keys" | "poly-refs" | "blobs";

export interface DoctorFinding {
  class: DoctorClass;
  /** Which file the finding is in. */
  file: "vault" | "journal";
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
    polyRefPairs: number;
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

function checkIntegrity(
  db: DatabaseSync,
  file: "vault" | "journal"
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const integrity = db.prepare("PRAGMA integrity_check").get() as
    | { integrity_check?: string }
    | undefined;
  const verdict = integrity?.integrity_check ?? "no result";
  if (verdict !== "ok") {
    findings.push({
      class: "integrity",
      file,
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
      file,
      detail: "PRAGMA foreign_key_check reported violations",
      count: violations.length,
      sample: [
        ...new Set(violations.map((row) => String(row.table ?? "?"))),
      ].slice(0, SAMPLE_LIMIT),
    });
  }
  return findings;
}

/**
 * Orphaned polymorphic pointers. A `type` this build does not recognise is NOT a
 * finding (an ext band or a newer vault may carry one); a recognised type
 * pointing at a missing row is the #441 failure exactly.
 */
function checkPolyRefs(
  vault: DatabaseSync,
  journal: DatabaseSync
): { findings: DoctorFinding[]; pairs: number } {
  const findings: DoctorFinding[] = [];
  let pairs = 0;
  for (const entry of POLY_REF_REGISTRY) {
    if (!tableExists(vault, entry.table)) continue;
    for (const pair of entry.pairs) {
      pairs += 1;
      const rows = vault
        .prepare(
          `SELECT DISTINCT "${pair.typeCol}" AS t, "${pair.idCol}" AS i
             FROM "${entry.table}"
            WHERE "${pair.typeCol}" IS NOT NULL AND "${pair.idCol}" IS NOT NULL`
        )
        .all() as { t: string; i: string }[];
      const orphans: string[] = [];
      // One prepared lookup per target table rather than per row: a populated
      // vault has orders of magnitude more pointers than pointed-at tables.
      const resolved = new Map<
        string,
        { db: DatabaseSync; sql: string } | null
      >();
      for (const row of rows) {
        let target = resolved.get(row.t);
        if (target === undefined) {
          const ref = resolveEntity(row.t, vault);
          const db = ref?.file === "journal" ? journal : vault;
          // `null` covers both "an unknown logical type" — an ext band or a
          // newer schema, which this build cannot call wrong — and "a known
          // type whose table this vault does not have".
          target =
            ref && tableExists(db, ref.physical)
              ? {
                  db,
                  sql: `SELECT 1 AS x FROM "${ref.physical}" WHERE "${primaryKeyOf(db, ref.physical) ?? "rowid"}" = ?`,
                }
              : null;
          resolved.set(row.t, target);
        }
        if (!target) continue;
        const live = target.db.prepare(target.sql).get(row.i);
        if (!live) orphans.push(`${row.t}:${row.i}`);
      }
      if (orphans.length > 0) {
        findings.push({
          class: "poly-refs",
          file: "vault",
          detail: `${entry.table}.(${pair.typeCol}, ${pair.idCol}) points at rows that no longer exist`,
          count: orphans.length,
          sample: orphans.slice(0, SAMPLE_LIMIT),
        });
      }
    }
  }
  return { findings, pairs };
}

function primaryKeyOf(db: DatabaseSync, physical: string): string | undefined {
  const cols = db.prepare(`PRAGMA table_info("${physical}")`).all() as {
    name: string;
    pk: number;
  }[];
  return cols.find((column) => column.pk === 1)?.name;
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
      file: "vault",
      detail:
        "blob_custody_state names content with no blob_replica row — the vault claims custody of bytes it has no location for",
      count: orphans.length,
      sample: orphans.slice(0, SAMPLE_LIMIT).map((row) => String(row.h)),
    });
  }
  return { findings, tables };
}

/** Read-only by construction — every statement is a `PRAGMA` or a `SELECT`. */
export function vaultDoctor(pair: {
  vault: DatabaseSync;
  journal: DatabaseSync;
}): DoctorReport {
  const findings: DoctorFinding[] = [
    ...checkIntegrity(pair.vault, "vault"),
    ...checkIntegrity(pair.journal, "journal"),
  ];
  const poly = checkPolyRefs(pair.vault, pair.journal);
  const blobs = checkBlobs(pair.vault);
  findings.push(...poly.findings, ...blobs.findings);
  return {
    ok: findings.length === 0,
    findings,
    checked: { polyRefPairs: poly.pairs, tablesWithBlobRefs: blobs.tables },
  };
}

/** The report as one readable block, for a CI log or a thrown error. */
export function formatDoctorReport(report: DoctorReport): string {
  if (report.ok) {
    return (
      `vault doctor: clean — ${report.checked.polyRefPairs} polymorphic reference pair(s) ` +
      `and ${report.checked.tablesWithBlobRefs} blob table(s) checked`
    );
  }
  const lines = [`vault doctor: ${report.findings.length} finding(s)`];
  for (const finding of report.findings) {
    lines.push(
      `  [${finding.class}] ${finding.file}: ${finding.detail} (${finding.count})` +
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
  journal: DatabaseSync;
}): DoctorReport {
  const report = vaultDoctor(pair);
  if (!report.ok) throw new Error(formatDoctorReport(report));
  return report;
}

/** Every `vault.db` under a root, with its sibling journal. */
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

/** Open one vault pair read-only and run the sweep over it. */
function inspectVaultDir(dir: string): DoctorReport {
  const vault = new DatabaseSync(path.join(dir, "vault.db"), {
    readOnly: true,
  });
  const journalPath = path.join(dir, "journal.db");
  const journal = existsSync(journalPath)
    ? new DatabaseSync(journalPath, { readOnly: true })
    : new DatabaseSync(":memory:");
  try {
    return vaultDoctor({ vault, journal });
  } finally {
    vault.close();
    journal.close();
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
