import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DoctorClass = "integrity" | "foreign-keys" | "blobs";

export interface DoctorFinding {
  class: DoctorClass;
  detail: string;
  count: number;
  sample: string[];
}

export interface DoctorReport {
  ok: boolean;
  findings: DoctorFinding[];
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

function foreignKeyCount(vault: DatabaseSync): number {
  const tables = vault
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as { name: string }[];
  let total = 0;
  for (const table of tables) {
    total += vault
      .prepare(`PRAGMA foreign_key_list(${JSON.stringify(table.name)})`)
      .all().length;
  }
  return total;
}

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

export function assertVaultHealthy(pair: {
  vault: DatabaseSync;
}): DoctorReport {
  const report = vaultDoctor(pair);
  if (!report.ok) throw new Error(formatDoctorReport(report));
  return report;
}

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

export function assertVaultTreeHealthy(root: string): {
  checked: string[];
  reports: DoctorReport[];
} {
  const dirs = vaultPairsUnder(root);
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
