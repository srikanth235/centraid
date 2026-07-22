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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

  for (const tgz of tarballs) {
    const args = ['publish', tgz, '--access', 'public'];
    if (effectiveDry) args.push('--dry-run');
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
