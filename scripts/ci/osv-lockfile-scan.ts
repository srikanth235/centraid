#!/usr/bin/env node
/**
 * Run OSV-Scanner against the monorepo lockfile and fail closed on CRITICAL
 * findings (#671). HIGH and below are reported for operators but do not fail
 * the gate — dependency-review already blocks *new* HIGH on the PR diff.
 *
 * Usage:
 *   osv-scanner must be on PATH (CI installs a pinned release).
 *   node scripts/ci/osv-lockfile-scan.ts
 *
 * Exit codes:
 *   0 — no CRITICAL (table printed)
 *   1 — CRITICAL present, or scanner/parse failure
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const lockfile = path.join(root, "bun.lock");
const config = path.join(root, "osv-scanner.toml");

/** CVSS / OSV score at or above this is treated as CRITICAL. */
const CRITICAL_SCORE = 9;
/** CVSS / OSV score at or above this (and below CRITICAL) is HIGH. */
const HIGH_SCORE = 7;
const MEDIUM_SCORE = 4;
const LOW_SCORE = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface OsvSummary {
  critical: string[];
  high: string[];
  totalPackages: number;
}

/** Map a severity label or numeric score to a comparable number. */
function severityScore(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const label = value.toUpperCase();
    if (label === "CRITICAL") return CRITICAL_SCORE;
    if (label === "HIGH") return HIGH_SCORE;
    if (label === "MEDIUM" || label === "MODERATE") return MEDIUM_SCORE;
    if (label === "LOW") return LOW_SCORE;
  }
  return 0;
}

/** Best-effort score for one vulnerability object. */
function vulnScore(vuln: unknown): number {
  if (!isRecord(vuln)) return 0;
  const db = vuln.database_specific;
  if (isRecord(db)) {
    const fromLabel = severityScore(db.severity);
    if (fromLabel >= CRITICAL_SCORE) return fromLabel;
    if (typeof db.cvss_score === "number") return db.cvss_score;
  }
  const severity = vuln.severity;
  if (Array.isArray(severity)) {
    let max = 0;
    for (const entry of severity) {
      if (isRecord(entry)) {
        max = Math.max(
          max,
          severityScore(entry.score),
          severityScore(entry.type)
        );
      }
    }
    if (max > 0) return max;
  }
  return 0;
}

/** Score for an OSV package group (`max_severity`). */
function groupScore(group: unknown): number {
  if (!isRecord(group)) return 0;
  return severityScore(group.max_severity);
}

/** Parse OSV-Scanner JSON and collect CRITICAL package findings. */
export function summarizeOsvReport(report: unknown): OsvSummary {
  const critical: string[] = [];
  const high: string[] = [];
  let totalPackages = 0;
  if (!isRecord(report)) {
    return { critical, high, totalPackages };
  }
  const results = report.results;
  if (!Array.isArray(results)) return { critical, high, totalPackages };

  for (const result of results) {
    if (!isRecord(result)) continue;
    const packages = result.packages;
    if (!Array.isArray(packages)) continue;
    for (const pkg of packages) {
      if (!isRecord(pkg)) continue;
      totalPackages += 1;
      const meta = pkg.package;
      const name = isRecord(meta) ? String(meta.name ?? "?") : "?";
      const version = isRecord(meta) ? String(meta.version ?? "?") : "?";

      let max = 0;
      const groups = pkg.groups;
      if (Array.isArray(groups)) {
        for (const g of groups) max = Math.max(max, groupScore(g));
      }
      const vulns = pkg.vulnerabilities;
      if (Array.isArray(vulns)) {
        for (const v of vulns) max = Math.max(max, vulnScore(v));
      }

      const line = `${name}@${version} (score ${max.toFixed(1)})`;
      if (max >= CRITICAL_SCORE) critical.push(line);
      else if (max >= HIGH_SCORE) high.push(line);
    }
  }
  return { critical, high, totalPackages };
}

export interface OsvScanResult {
  code: number;
  table: string;
  summary: OsvSummary;
}

/** Invoke osv-scanner on bun.lock and classify findings. */
export function runOsvLockfileScan(osvBin = "osv-scanner"): OsvScanResult {
  if (!existsSync(lockfile)) {
    return {
      code: 1,
      table: `missing lockfile: ${lockfile}\n`,
      summary: { critical: ["missing-lockfile"], high: [], totalPackages: 0 },
    };
  }

  const tableArgs = [
    "scan",
    `--lockfile=${lockfile}`,
    `--config=${config}`,
    "--format=table",
  ];
  const tableRun = spawnSync(osvBin, tableArgs, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const table = `${tableRun.stdout ?? ""}${tableRun.stderr ?? ""}`;

  const jsonArgs = [
    "scan",
    `--lockfile=${lockfile}`,
    `--config=${config}`,
    "--format=json",
  ];
  const jsonRun = spawnSync(osvBin, jsonArgs, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = (jsonRun.stdout ?? "").trim();
  if (!raw) {
    return {
      code: 1,
      table: `${table}\nosv-scanner produced no JSON (exit ${jsonRun.status})\n`,
      summary: {
        critical: ["osv-scanner-no-json"],
        high: [],
        totalPackages: 0,
      },
    };
  }
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    return {
      code: 1,
      table: `${table}\nosv-scanner JSON parse failed: ${String(error)}\n`,
      summary: {
        critical: ["osv-scanner-json-parse"],
        high: [],
        totalPackages: 0,
      },
    };
  }
  const summary = summarizeOsvReport(report);
  const code = summary.critical.length > 0 ? 1 : 0;
  return { code, table, summary };
}

function main(): void {
  const result = runOsvLockfileScan(
    process.env.OSV_SCANNER_BIN || "osv-scanner"
  );

  process.stdout.write(result.table);
  if (!result.table.endsWith("\n")) process.stdout.write("\n");

  const { critical, high, totalPackages } = result.summary;
  console.log(
    `osv-lockfile-scan: packages_with_vulns≈${totalPackages} critical=${critical.length} high=${high.length}`
  );
  if (high.length > 0) {
    console.log(
      "HIGH (reported, non-blocking — dependency-review covers new HIGH):"
    );
    for (const line of high.slice(0, 30)) console.log(`  - ${line}`);
    if (high.length > 30) console.log(`  … +${high.length - 30} more`);
  }
  if (critical.length > 0) {
    console.error("CRITICAL (blocking):");
    for (const line of critical) console.error(`  - ${line}`);
    process.exit(1);
  }
  process.exit(result.code);
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href;
if (isMain) {
  main();
}
