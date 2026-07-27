#!/usr/bin/env node
/**
 * Publish packed gateway packages to npm (issue #509).
 * Requires NPM_TOKEN (or npm already logged in). Dry-run when token absent
 * unless --force-dry-run / --require-token.
 *
 * Usage:
 *   node scripts/gateway-npm/publish.mjs [--pack-dir artifacts/npm-packs] [--dry-run]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = import.meta.dirname;
const ROOT = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  let packDir = path.join(ROOT, 'artifacts/npm-packs');
  let dryRun = false;
  let requireToken = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pack-dir') packDir = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--require-token') requireToken = true;
  }
  return { packDir, dryRun, requireToken };
}

function main() {
  const { packDir, dryRun, requireToken } = parseArgs(process.argv.slice(2));
  const token = process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || '';
  const effectiveDry = dryRun || !token;

  if (requireToken && !token) {
    console.error('gateway-npm publish: NPM_TOKEN / NODE_AUTH_TOKEN required (--require-token)');
    process.exit(1);
  }
  if (!fs.existsSync(packDir)) {
    console.error(`gateway-npm publish: pack dir missing: ${packDir} (run pack.mjs first)`);
    process.exit(1);
  }

  const tarballs = fs
    .readdirSync(packDir)
    .filter((n) => n.endsWith('.tgz'))
    .sort()
    .map((n) => path.join(packDir, n));

  if (tarballs.length === 0) {
    console.error('gateway-npm publish: no .tgz files in pack dir');
    process.exit(1);
  }

  console.log(
    `gateway-npm publish: ${tarballs.length} tarball(s)${effectiveDry ? ' [DRY-RUN — no token or --dry-run]' : ''}`,
  );

  // #557 — npm provenance. Publishing signs a build attestation linking the
  // tarball to this workflow, commit, and runner; consumers can verify the
  // package really came from this repo rather than a stolen NPM_TOKEN.
  //
  // Gated on ACTIONS_ID_TOKEN_REQUEST_URL, which GitHub only injects when the
  // job declares `permissions: id-token: write`. `npm publish --provenance`
  // HARD FAILS without it, so this must stay a runtime probe rather than an
  // unconditional flag — a local `node publish.mjs` must keep working.
  const canProvenance = Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (!effectiveDry && !canProvenance) {
    console.warn(
      'gateway-npm publish: publishing WITHOUT provenance (no OIDC token; is `id-token: write` set on the job?)',
    );
  }

  for (const tgz of tarballs) {
    const args = ['publish', tgz, '--access', 'public'];
    if (effectiveDry) args.push('--dry-run');
    else if (canProvenance) args.push('--provenance');
    console.log(`  npm ${args.join(' ')}`);
    const env = { ...process.env };
    if (token) {
      // Project-local auth for CI; do not print token.
      env.NODE_AUTH_TOKEN = token;
    }
    const r = spawnSync('npm', args, { encoding: 'utf8', env, cwd: ROOT });
    if (r.status !== 0) {
      console.error(r.stdout, r.stderr);
      process.exit(r.status ?? 1);
    }
    if (r.stdout) process.stdout.write(r.stdout);
  }
  console.log('gateway-npm publish: done');
}

main();
