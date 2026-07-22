#!/usr/bin/env node
/**
 * D2 prepare half of the release chain (see docs/release.md).
 *
 * Agent runs this to *prepare* — never publish. Steps:
 *   1. assert working tree clean (optional --allow-dirty)
 *   2. run `bun run check:pr` unless --skip-check
 *   3. classify bump from CHANGELOG Unreleased (D4)
 *   4. print next version + surface matrix + publish command
 *
 * Authorization boundary: running this script is intent, not permission to
 * tag or push. Publish is scripts/release/publish.mjs after maintainer "go".
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSurfaceMatrix, defaultShipSurfaceIds } from './surfaces.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Set(process.argv.slice(2));
const allowDirty = args.has('--allow-dirty');
const skipCheck = args.has('--skip-check');

function sh(cmd) {
  return execSync(cmd, { cwd: root, encoding: 'utf8' });
}

if (!allowDirty) {
  const status = sh('git status --porcelain');
  if (status.trim()) {
    console.error('working tree not clean; commit or pass --allow-dirty');
    process.exit(1);
  }
}

if (!skipCheck) {
  console.error('running bun run check:pr …');
  try {
    execSync('bun run check:pr', { cwd: root, stdio: 'inherit' });
  } catch {
    console.error('check:pr failed — fix before preparing a release');
    process.exit(1);
  }
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const current = pkg.version;
const classOut = JSON.parse(sh('node scripts/release/classify.mjs CHANGELOG.md'));

function bumpSemver(v, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(v);
  if (!m) throw new Error(`unparseable version ${v}`);
  let maj = Number(m[1]);
  let min = Number(m[2]);
  let pat = Number(m[3]);
  if (kind === 'major') {
    console.error('agents never propose major before 1.0 (D4/F1)');
    process.exit(2);
  }
  if (kind === 'minor') {
    min += 1;
    pat = 0;
  } else {
    pat += 1;
  }
  return `${maj}.${min}.${pat}`;
}

const next = bumpSemver(current, classOut.bump);
const defaultShip = defaultShipSurfaceIds();
const surfaces = buildSurfaceMatrix({ shipIds: defaultShip });

let secretsProbe = null;
try {
  secretsProbe = JSON.parse(sh('node scripts/release/verify-secrets.mjs'));
} catch {
  secretsProbe = { note: 'verify-secrets failed to run', groups: {} };
}

const report = {
  current,
  next,
  bump: classOut.bump,
  rationale: classOut.rationale,
  versioning: {
    product: 'One monorepo semver; stamp all packages; surfaces may skip ship not stamps.',
    buildNumber: 'Script-derived major*1e6+minor*1e3+patch; resubmit needs a new patch.',
    protocol: 'Connect gate only; see GATEWAY_PROTOCOL_VERSION in @centraid/protocol.',
  },
  surfaces: {
    defaultShip,
    continuous: surfaces.surfaces.filter((s) => s.cadence === 'continuous').map((s) => s.id),
    storeOptIn: surfaces.surfaces.filter((s) => s.cadence === 'store').map((s) => s.id),
    matrix: surfaces,
  },
  secrets: secretsProbe.groups,
  publishCommand: `node scripts/release/publish.mjs --version ${next} --issue N --surfaces ${defaultShip.join(',')}`,
  note: 'Maintainer must explicitly authorize publish. Prepare ≠ publish (D1). Never bump version only to fix a failed build (retry same tag / surface rebuild).',
};

try {
  mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(root, 'artifacts', 'release-prepare.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
} catch {
  // optional
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
