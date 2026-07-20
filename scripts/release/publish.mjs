#!/usr/bin/env node
/**
 * D2 publish half — only after maintainer authorization (docs/release.md D1).
 *
 *   node scripts/release/publish.mjs --version 0.2.1 [--dry-run] [--beta]
 *
 * - Bumps the single shared monorepo version across package.json workspaces
 *   that currently match the previous root version
 * - Moves CHANGELOG Unreleased into the versioned section
 * - Creates annotated tag vX.Y.Z (or vX.Y.Z-beta.N with --beta)
 * - Does NOT push unless --push is passed
 *
 * Tag push fans out to release workflows (desktop package, checksums, GH release).
 */

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
let version = null;
let dryRun = false;
let beta = false;
let doPush = false;
let betaN = 1;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--version') version = args[++i];
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--beta') beta = true;
  else if (args[i] === '--beta-n') betaN = Number(args[++i]);
  else if (args[i] === '--push') doPush = true;
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    'usage: node scripts/release/publish.mjs --version X.Y.Z [--beta] [--dry-run] [--push]',
  );
  process.exit(2);
}

const rootPkgPath = path.join(root, 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
const prev = rootPkg.version;
const tag = beta ? `v${version}-beta.${betaN}` : `v${version}`;

function collectPackageJsons() {
  const out = [rootPkgPath];
  for (const dir of ['packages', 'apps']) {
    const base = path.join(root, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const p = path.join(base, name, 'package.json');
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

function bumpPackages() {
  for (const p of collectPackageJsons()) {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j.version === prev || p === rootPkgPath) {
      j.version = version;
      if (!dryRun) writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    }
  }
}

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

console.error(`publish ${prev} → ${version} tag ${tag}${dryRun ? ' (dry-run)' : ''}`);
bumpPackages();
foldChangelog();
const body = extractReleaseBody();
const bodyPath = path.join(root, 'artifacts', 'release-body.md');
if (!dryRun) {
  try {
    writeFileSync(bodyPath, body + '\n');
  } catch {
    /* optional */
  }
}

if (dryRun) {
  console.log(
    JSON.stringify({ version, tag, prev, bodyPath, bodyPreview: body.slice(0, 200) }, null, 2),
  );
  process.exit(0);
}

execSync('git add package.json packages/*/package.json apps/*/package.json CHANGELOG.md', {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});
execSync(`git commit -m "chore(release): ${version} (#0)"`, { cwd: root, stdio: 'inherit' });
// Note: real releases should use the issue number; #0 is a placeholder for dry tooling.
// Prefer: chore(release): 0.2.1 (#468) when shipping from a tracked issue.
execSync(`git tag -a ${tag} -m "Centraid ${tag}"`, { cwd: root, stdio: 'inherit' });

if (doPush) {
  execSync('git push origin HEAD', { cwd: root, stdio: 'inherit' });
  execSync(`git push origin ${tag}`, { cwd: root, stdio: 'inherit' });
} else {
  console.error(
    `tag ${tag} created locally. Push with: git push origin HEAD && git push origin ${tag}`,
  );
}

console.log(JSON.stringify({ version, tag, bodyPath }, null, 2));
