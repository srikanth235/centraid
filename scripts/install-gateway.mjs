#!/usr/bin/env node
/**
 * Centraid gateway installer — npm path (issue #509).
 * Invoked by scripts/install-gateway.sh for curl|bash hosting.
 *
 * Stages (OpenClaw-like): check Node → npm install package or local packs →
 * print next steps. Never silently installs OS services.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNpmInstallArgs,
  defaultInstallPrefix,
  formatPostInstallMessage,
  minNodeMajorFromEngines,
  nodeVersionSatisfies,
  parseInstallArgs,
} from './gateway-npm/pack-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Centraid gateway installer (npm path)

Usage:
  bash scripts/install-gateway.sh [options]     # macOS / Linux
  curl -fsSL …/install-gateway.sh | bash -s -- [options]
  node scripts/install-gateway.mjs [options]

  Windows (PowerShell): npm install -g @centraid/gateway
  (multi-OS tunnel NAPI ships in the package — see README / #511)

Options:
  --prefix <dir>          npm --prefix (implies non-global)
  --global                npm -g (default when no --prefix)
  --no-global             prefix ~/.centraid
  --version <spec>        npm version/dist-tag (default: latest)
  --from-pack-dir <dir>   install local npm pack tarballs
  --with-service          print opt-in service install command
  --dry-run               print plan only
  --help, -h
`);
}

function listPackFiles(fromPackDir) {
  const dir = path.resolve(fromPackDir);
  if (!fs.existsSync(dir)) throw new Error(`pack dir missing: ${dir}`);
  const manifestPath = path.join(dir, 'manifest.json');
  /** @type {string[]} */
  let packFiles = [];
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const t of m.tarballs || []) {
      const full = path.join(dir, t);
      if (fs.existsSync(full)) packFiles.push(full);
    }
  }
  if (packFiles.length === 0) {
    packFiles = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.tgz'))
      .sort()
      .map((n) => path.join(dir, n));
  }
  return packFiles;
}

function main(argv) {
  let args;
  try {
    args = parseInstallArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  if (args.help) {
    usage();
    return;
  }

  const minMajor = minNodeMajorFromEngines('>=22.5');
  if (!nodeVersionSatisfies(process.version, minMajor)) {
    console.error(`Node.js >= ${minMajor} required (found ${process.version})`);
    process.exit(1);
  }
  if (!spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout) {
    console.error('npm is required on PATH');
    process.exit(1);
  }

  const home = process.env.HOME || '';
  let prefix = args.prefix;
  let useGlobal = args.global && !prefix;
  if (!useGlobal && !prefix) {
    prefix = defaultInstallPrefix(home);
  }

  const packFiles = args.fromPackDir ? listPackFiles(args.fromPackDir) : [];
  let installTargets;
  try {
    installTargets = buildNpmInstallArgs({
      version: args.version,
      fromPackDir: args.fromPackDir,
      packFiles,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  /** @type {string[]} */
  const npmArgs = ['install'];
  if (useGlobal) npmArgs.push('-g');
  else {
    npmArgs.push('--prefix', /** @type {string} */ (prefix));
    fs.mkdirSync(/** @type {string} */ (prefix), { recursive: true });
  }
  npmArgs.push(...installTargets);

  console.log(`==> Centraid gateway install (node ${process.version})`);
  console.log(`==> npm ${npmArgs.join(' ')}`);

  if (args.dryRun) {
    console.log(
      formatPostInstallMessage({
        bin: 'centraid-gateway',
        prefix: useGlobal ? null : prefix,
        withService: args.withService,
      }),
    );
    console.log('OK dry-run complete');
    return;
  }

  const r = spawnSync('npm', npmArgs, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);

  // npm --prefix puts bins under <prefix>/node_modules/.bin; global under npm bin -g.
  // Symlink into <prefix>/bin for OpenClaw-like PATH (~/.centraid/bin).
  let binPath = '';
  if (useGlobal) {
    const gbin = (spawnSync('npm', ['bin', '-g'], { encoding: 'utf8' }).stdout || '').trim();
    binPath = path.join(gbin, 'centraid-gateway');
  } else {
    const p = /** @type {string} */ (prefix);
    const nmBin = path.join(p, 'node_modules', '.bin', 'centraid-gateway');
    const userBin = path.join(p, 'bin');
    fs.mkdirSync(userBin, { recursive: true });
    const dest = path.join(userBin, 'centraid-gateway');
    if (fs.existsSync(nmBin)) {
      try {
        fs.rmSync(dest, { force: true });
        fs.symlinkSync(nmBin, dest);
      } catch {
        fs.copyFileSync(nmBin, dest);
        fs.chmodSync(dest, 0o755);
      }
      binPath = dest;
    }
  }
  if (binPath && fs.existsSync(binPath)) {
    console.log(`OK centraid-gateway → ${binPath}`);
    spawnSync(binPath, ['--help'], { stdio: 'inherit' });
  } else {
    console.log('OK install finished; ensure npm bin dir is on PATH');
  }

  console.log(
    formatPostInstallMessage({
      bin: 'centraid-gateway',
      prefix: useGlobal ? null : prefix,
      withService: args.withService,
    }),
  );

  if (args.withService) {
    console.log('==> Opt-in service install (existing CLI writer only):');
    console.log(
      `  ${fs.existsSync(binPath) ? binPath : 'centraid-gateway'} service install --data-dir ~/.local/share/centraid/gateway`,
    );
  }
  console.log('OK gateway install complete');
}

main(process.argv.slice(2));
