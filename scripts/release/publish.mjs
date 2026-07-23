#!/usr/bin/env node
/**
 * D2 publish half — only after maintainer authorization (docs/release.md D1).
 *
 *   node scripts/release/publish.mjs --version 0.2.1 --issue 501 \
 *     [--surfaces desktop,gateway-image,gateway-npm] [--dry-run] [--beta] [--push]
 *
 * - Requires --issue N (governance commit suffix; refuse #0)
 * - Bumps monorepo + mobile native numbers via sync-versions.mjs (all stamps)
 * - Records ship surface set (does not invent surface-local versions)
 * - Moves CHANGELOG Unreleased into the versioned section
 * - Creates annotated tag vX.Y.Z (or vX.Y.Z-beta.N with --beta)
 * - Does NOT push unless --push is passed
 *
 * Tag push fans out to tag-triggered workflows. Mobile remains dispatch-opt-in.
 * Never bump version only to fix a failed build — rebuild / retry tag instead.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSyncVersions } from './sync-versions.mjs';
import { buildSurfaceMatrix, defaultShipSurfaceIds, resolveShipSurfaces } from './surfaces.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
let version = null;
let issue = null;
let dryRun = false;
let beta = false;
let doPush = false;
let betaN = 1;
/** @type {string[] | null} */
let shipIds = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--version') version = args[++i];
  else if (args[i] === '--issue') issue = args[++i];
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--beta') beta = true;
  else if (args[i] === '--beta-n') betaN = Number(args[++i]);
  else if (args[i] === '--push') doPush = true;
  else if (args[i] === '--surfaces') {
    const raw = args[++i] ?? '';
    shipIds = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    'usage: node scripts/release/publish.mjs --version X.Y.Z --issue N [--surfaces a,b] [--beta] [--dry-run] [--push]',
  );
  process.exit(2);
}
if (!issue || !/^\d+$/.test(issue) || issue === '0') {
  console.error('publish requires --issue N (real GitHub issue; #0 is forbidden)');
  process.exit(2);
}

const resolvedShip = shipIds ?? defaultShipSurfaceIds();
const shipResolved = resolveShipSurfaces(resolvedShip);
if (!shipResolved.ok) {
  console.error(shipResolved.error);
  process.exit(2);
}
const continuousOnly = shipResolved.surfaces.every(
  (s) => s.cadence === 'continuous' || s.cadence === 'sideline',
);
if (continuousOnly && resolvedShip.length > 0) {
  const allContinuous = shipResolved.surfaces.every((s) => s.cadence === 'continuous');
  if (allContinuous) {
    console.error(
      'refusing publish that only lists continuous surfaces (web/docs/oauth-worker) — deploy from main, not v* tags',
    );
    process.exit(2);
  }
}

const rootPkgPath = path.join(root, 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
const prev = rootPkg.version;
const tag = beta ? `v${version}-beta.${betaN}` : `v${version}`;
const shipManifest = {
  version,
  tag,
  issue: `#${issue}`,
  surfaces: resolvedShip,
  matrix: buildSurfaceMatrix({ shipIds: resolvedShip }),
  createdAt: new Date().toISOString(),
  note: 'Monorepo stamps all packages; ship set is intent for which workflows must go green.',
};

function foldChangelog() {
  const clPath = path.join(root, 'CHANGELOG.md');
  if (!existsSync(clPath)) return;
  let text = readFileSync(clPath, 'utf8');
  const date = new Date().toISOString().slice(0, 10);
  if (!text.includes('## [Unreleased]')) return;
  text = text.replace('## [Unreleased]', `## [Unreleased]\n\n## [${version}] - ${date}`);
  if (!dryRun) writeFileSync(clPath, text);
}

function extractReleaseBody() {
  const clPath = path.join(root, 'CHANGELOG.md');
  if (!existsSync(clPath)) return `Centraid ${version}`;
  const text = readFileSync(clPath, 'utf8');
  const re = new RegExp(
    `^##\\s+\\[${version.replace(/\./g, '\\.')}\\][^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|$)`,
    'm',
  );
  const m = text.match(re);
  return (m?.[1] ?? '').trim() || `Centraid ${version}`;
}

console.error(
  `publish ${prev} → ${version} tag ${tag} (#${issue}) surfaces=[${resolvedShip.join(',')}]${dryRun ? ' (dry-run)' : ''}`,
);

const syncReport = runSyncVersions({ rootDir: root, version, dryRun });
foldChangelog();
const body = extractReleaseBody();
const bodyPath = path.join(root, 'artifacts', 'release-body.md');
const shipPath = path.join(root, 'artifacts', 'release-ship.json');
if (!dryRun) {
  try {
    mkdirSync(path.dirname(bodyPath), { recursive: true });
    writeFileSync(bodyPath, body + '\n');
    writeFileSync(shipPath, JSON.stringify(shipManifest, null, 2) + '\n');
  } catch {
    /* optional */
  }
}

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        version,
        tag,
        prev,
        issue,
        surfaces: resolvedShip,
        shipManifest,
        syncReport,
        bodyPath,
        bodyPreview: body.slice(0, 200),
        mobileHint: resolvedShip.includes('mobile')
          ? 'gh workflow run release-mobile.yml -f profile=preview -f platform=all -f submit=false'
          : undefined,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const commitMsg = `chore(release): ${version} (#${issue})`;
execSync(
  'git add package.json packages/*/package.json apps/*/package.json CHANGELOG.md ' +
    'apps/mobile/android/app/build.gradle ' +
    'apps/mobile/ios/Centraid.xcodeproj/project.pbxproj ' +
    'apps/mobile/ios/Centraid/Info.plist ' +
    'apps/mobile/ios/ShareExtension/ShareExtension-Info.plist 2>/dev/null || true',
  { cwd: root, stdio: 'inherit', shell: true },
);
execSync(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd: root, stdio: 'inherit' });
execSync(`git tag -a ${tag} -m "Centraid ${tag}"`, { cwd: root, stdio: 'inherit' });

if (doPush) {
  execSync('git push origin HEAD', { cwd: root, stdio: 'inherit' });
  execSync(`git push origin ${tag}`, { cwd: root, stdio: 'inherit' });
} else {
  console.error(
    `tag ${tag} created locally. Push with: git push origin HEAD && git push origin ${tag}`,
  );
}

if (resolvedShip.includes('mobile')) {
  console.error(
    'mobile is in the ship set — after tag push, dispatch:\n' +
      '  gh workflow run release-mobile.yml -f profile=preview -f platform=all -f submit=false',
  );
}

console.log(
  JSON.stringify(
    {
      version,
      tag,
      issue,
      surfaces: resolvedShip,
      bodyPath,
      shipPath,
      build: syncReport.build,
    },
    null,
    2,
  ),
);
