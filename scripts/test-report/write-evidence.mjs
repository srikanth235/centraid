import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  EVIDENCE_SCHEMA_VERSION,
  evidenceFileName,
  validateEvidence,
} from "./evidence-schema.mjs";

const root = path.resolve(import.meta.dirname, "../..");

export const PARK_SOURCES = Object.freeze(["tests/quarantine.json"]);

export function parseArgs(argv, known) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!known.has(name)) throw new Error(`unknown flag: --${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} needs a value`);
    }
    flags[name] = value;
    index += 1;
  }
  return flags;
}

const KNOWN_FLAGS = new Set([
  "lane",
  "rung",
  "platform",
  "verdict",
  "job-status",
  "started-at",
  "finished-at",
  "budget-ms",
  "duration-ms",
  "cases",
  "qualities",
  "surfaces",
  "candidate",
  "out",
]);

export function resolveVerdict(verdict, jobStatus) {
  if (verdict !== "auto") return verdict;
  if (!jobStatus) throw new Error("--verdict auto needs --job-status");
  return jobStatus === "success" ? "passed" : "failed";
}

export function lookupPark(lane, readText, today) {
  for (const source of PARK_SOURCES) {
    const text = readText(source);
    if (!text) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${source} is not valid JSON`);
    }
    const entry = parsed?.lanes?.[lane];
    if (!entry) continue;
    const until = String(entry.expires ?? entry.until ?? "");
    if (!until || until < today) continue;
    const issue = Number(String(entry.issue ?? "").replace(/^#/u, ""));
    if (!Number.isInteger(issue) || issue <= 0) {
      throw new Error(`${source} lane park for ${lane} has no issue number`);
    }
    return { until, issue };
  }
  return null;
}

function tagList(value) {
  return value === undefined
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

export function buildEvidence(flags, context) {
  const startedAt = flags["started-at"];
  if (!startedAt) throw new Error("--started-at is required");
  const finishedAt = flags["finished-at"] ?? context.now.toISOString();
  const declared = resolveVerdict(flags.verdict ?? "", flags["job-status"]);
  const verdict = context.park && declared === "failed" ? "parked" : declared;
  const durationMs =
    flags["duration-ms"] === undefined
      ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
      : Number(flags["duration-ms"]);

  return {
    schema: EVIDENCE_SCHEMA_VERSION,
    lane: flags.lane,
    rung: Number(flags.rung),
    platform: flags.platform,
    candidate: flags.candidate ? flags.candidate : null,
    startedAt,
    finishedAt,
    verdict,
    budgetMs: Number(flags["budget-ms"] ?? 0),
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    cases: context.cases,
    parked: context.park,
    tags: {
      qualities: tagList(flags.qualities),
      surfaces: tagList(flags.surfaces),
    },
  };
}

function readCases(casesPath) {
  if (!casesPath) return [];
  const parsed = JSON.parse(
    readFileSync(path.resolve(root, casesPath), "utf8")
  );
  if (!Array.isArray(parsed)) throw new Error("--cases must name a JSON array");
  return parsed;
}

export function main(argv, options = {}) {
  const flags = parseArgs(argv, KNOWN_FLAGS);
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const readText =
    options.readText ??
    ((relative) => {
      try {
        return readFileSync(path.join(root, relative), "utf8");
      } catch {
        return null;
      }
    });

  const park = lookupPark(String(flags.lane ?? ""), readText, today);
  const evidence = buildEvidence(flags, {
    now,
    park,
    cases: readCases(flags.cases),
  });
  const { ok, errors } = validateEvidence(evidence);
  if (!ok) {
    throw new Error(
      `refusing to write invalid evidence:\n  ${errors.join("\n  ")}`
    );
  }

  const outDir = path.resolve(root, flags.out ?? "artifacts/evidence");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, evidenceFileName(evidence.lane));
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return { file, evidence };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  try {
    const { file } = main(process.argv.slice(2));
    process.stdout.write(`wrote ${path.relative(root, file)}\n`);
  } catch (error) {
    process.stderr.write(`write-evidence: ${error.message}\n`);
    process.exitCode = 1;
  }
}
