#!/usr/bin/env node
/**
 * D2 prepare half of the release chain (see docs/release.md).
 *
 * Agent runs this to *prepare* — never publish. Steps:
 *   0. assert HEAD is a promoted candidate (optional --allow-uncandidated)
 *   1. assert working tree clean (optional --allow-dirty)
 *   2. run `bun run check:pr` unless --skip-check
 *   3. classify bump from CHANGELOG Unreleased (D4)
 *   4. print next version + surface matrix + publish command
 *
 * Authorization boundary: running this script is intent, not permission to
 * tag or push. Publish is scripts/release/publish.ts after maintainer "go".
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { assertHeadIsCandidate } from "./candidate-guard.ts";
import { assertNoOpenNightlyQualityIssues } from "./nightly-quality-blockers.ts";
import { buildSurfaceMatrix, defaultShipSurfaceIds } from "./surfaces.ts";

const root = path.resolve(import.meta.dirname, "../..");
const args = new Set(process.argv.slice(2));
const allowDirty = args.has("--allow-dirty");
const skipCheck = args.has("--skip-check");

// #915 Wave 1 — FIRST, because it is the cheapest refusal and the one whose
// remedy takes the longest. Everything below versions, classifies and prints a
// publish command; none of that is worth doing for a SHA rung 3 never promoted.
// `release.yml`'s `require-candidate` job enforces the same rule after the tag
// exists, but being told here means never cutting the tag at all.
assertHeadIsCandidate({ argv: process.argv.slice(2) });

assertNoOpenNightlyQualityIssues();

function sh(cmd: string) {
  return execSync(cmd, { cwd: root, encoding: "utf8" });
}

if (!allowDirty) {
  const status = sh("git status --porcelain");
  if (status.trim()) {
    console.error("working tree not clean; commit or pass --allow-dirty");
    process.exit(1);
  }
}

if (!skipCheck) {
  console.error("running bun run check:pr …");
  try {
    execSync("bun run check:pr", { cwd: root, stdio: "inherit" });
  } catch {
    console.error("check:pr failed — fix before preparing a release");
    process.exit(1);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const pkg: unknown = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8")
);
if (!isRecord(pkg) || typeof pkg.version !== "string") {
  throw new Error("root package.json is missing a version");
}
const current = pkg.version;
const classOut: unknown = JSON.parse(
  sh("node scripts/release/classify.ts CHANGELOG.md")
);

function bumpSemver(v: string, kind: string) {
  const m = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-.*)?$/u.exec(v);
  if (!m?.groups) throw new Error(`unparseable version ${v}`);
  const maj = Number(m.groups.major);
  let min = Number(m.groups.minor);
  let pat = Number(m.groups.patch);
  if (kind === "major") {
    console.error("agents never propose major before 1.0 (D4/F1)");
    process.exit(2);
  }
  if (kind === "minor") {
    min += 1;
    pat = 0;
  } else {
    pat += 1;
  }
  return `${maj}.${min}.${pat}`;
}

if (!isRecord(classOut) || typeof classOut.bump !== "string") {
  throw new Error("classify.ts did not emit a bump");
}
const next = bumpSemver(current, classOut.bump);
const defaultShip = defaultShipSurfaceIds();
const surfaces = buildSurfaceMatrix({ shipIds: defaultShip });

let secretsProbe = null;
try {
  secretsProbe = JSON.parse(sh("node scripts/release/verify-secrets.ts"));
} catch {
  secretsProbe = { note: "verify-secrets failed to run", groups: {} };
}

const report = {
  current,
  next,
  bump: classOut.bump,
  rationale: classOut.rationale,
  versioning: {
    product:
      "One monorepo semver; stamp all packages; surfaces may skip ship not stamps.",
    buildNumber:
      "Script-derived major*1e6+minor*1e3+patch; resubmit needs a new patch.",
    protocol:
      "Connect gate only; see GATEWAY_PROTOCOL_VERSION in @centraid/core/protocol.",
  },
  surfaces: {
    defaultShip,
    continuous: surfaces.surfaces
      .filter((s) => s.cadence === "continuous")
      .map((s) => s.id),
    storeOptIn: surfaces.surfaces
      .filter((s) => s.cadence === "store")
      .map((s) => s.id),
    matrix: surfaces,
  },
  secrets: secretsProbe.groups,
  publishCommand: `node scripts/release/publish.ts --version ${next} --issue N --surfaces ${defaultShip.join(",")}`,
  note: "Maintainer must explicitly authorize publish. Prepare ≠ publish (D1). Never bump version only to fix a failed build (retry same tag / surface rebuild).",
};

try {
  mkdirSync(path.join(root, "artifacts"), { recursive: true });
  writeFileSync(
    path.join(root, "artifacts", "release-prepare.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
} catch {
  // optional
}

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
