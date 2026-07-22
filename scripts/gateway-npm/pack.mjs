#!/usr/bin/env node
/**
 * Pack the gateway publish set for npm (issue #509).
 * Rewrites workspace:* → concrete versions; does not publish.
 *
 * Usage:
 *   node scripts/gateway-npm/pack.mjs [--out artifacts/npm-packs] [--dry-run]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteWorkspaceDependencies, topologicalPublishOrder } from './pack-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  let out = path.join(ROOT, 'artifacts/npm-packs');
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/gateway-npm/pack.mjs [--out dir] [--dry-run]');
      process.exit(0);
    }
  }
  return { out, dryRun };
}

function loadPublishSet() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'publish-set.json'), 'utf8'));
}

function readPkg(dir) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', dir, 'package.json'), 'utf8'));
}

function main() {
  const { out, dryRun } = parseArgs(process.argv.slice(2));
  const set = loadPublishSet();
  const order = topologicalPublishOrder(set.packages, (dir) => {
    const p = readPkg(dir);
    return {
      name: p.name,
      version: p.version,
      dependencies: p.dependencies,
    };
  });

  /** @type {Record<string, string>} */
  const versionByName = {};
  for (const dir of order) {
    const p = readPkg(dir);
    versionByName[p.name] = p.version;
  }

  fs.mkdirSync(out, { recursive: true });
  console.log(`gateway-npm pack: ${order.length} package(s) → ${out}${dryRun ? ' (dry-run)' : ''}`);

  /** @type {string[]} */
  const tarballs = [];
  for (const dir of order) {
    const srcPkg = readPkg(dir);
    const { packageJson, rewrote } = rewriteWorkspaceDependencies(srcPkg, versionByName);
    const staging = path.join(out, '.staging', dir);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    // Copy packable tree from package files field + package.json
    const pkgRoot = path.join(ROOT, 'packages', dir);
    const files = Array.isArray(srcPkg.files) ? srcPkg.files : ['dist', 'README.md'];
    for (const rel of files) {
      // Support globs like native/*.node by copying parent dir patterns simply:
      if (rel.includes('*')) {
        const parent = path.dirname(rel);
        const base = path.basename(rel);
        const fromDir = path.join(pkgRoot, parent);
        if (!fs.existsSync(fromDir)) continue;
        const destDir = path.join(staging, parent);
        fs.mkdirSync(destDir, { recursive: true });
        for (const name of fs.readdirSync(fromDir)) {
          // crude glob: only * as suffix/prefix on basename
          const re = new RegExp('^' + base.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
          if (!re.test(name)) continue;
          fs.cpSync(path.join(fromDir, name), path.join(destDir, name), { recursive: true });
        }
        continue;
      }
      const from = path.join(pkgRoot, rel);
      if (!fs.existsSync(from)) {
        console.warn(`  warn: missing ${dir}/${rel} (build first?)`);
        continue;
      }
      const to = path.join(staging, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    }
    fs.writeFileSync(
      path.join(staging, 'package.json'),
      JSON.stringify(packageJson, null, 2) + '\n',
    );

    console.log(
      `  ${packageJson.name}@${packageJson.version} (rewrote ${rewrote.length} workspace deps)`,
    );

    if (dryRun) {
      // npm pack --dry-run from staging
      const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: staging,
        encoding: 'utf8',
        env: process.env,
      });
      if (r.status !== 0) {
        console.error(r.stdout, r.stderr);
        process.exit(r.status ?? 1);
      }
      console.log(`    dry-run ok`);
      continue;
    }

    const r = spawnSync('npm', ['pack', '--pack-destination', out], {
      cwd: staging,
      encoding: 'utf8',
      env: process.env,
    });
    if (r.status !== 0) {
      console.error(r.stdout, r.stderr);
      process.exit(r.status ?? 1);
    }
    const packedLines = (r.stdout || '').trim().split('\n');
    let line;
    for (let i = packedLines.length - 1; i >= 0; i--) {
      if (packedLines[i]) {
        line = packedLines[i];
        break;
      }
    }
    if (line) {
      const full = path.isAbsolute(line) ? line : path.join(out, line);
      tarballs.push(full);
      console.log(`    → ${path.basename(full)}`);
    }
  }

  fs.rmSync(path.join(out, '.staging'), { recursive: true, force: true });
  const manifest = {
    createdAt: new Date().toISOString(),
    packages: order.map((dir) => {
      const p = readPkg(dir);
      return { dir, name: p.name, version: p.version };
    }),
    tarballs: tarballs.map((t) => path.basename(t)),
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`gateway-npm pack: done (${tarballs.length || order.length} package(s))`);
}

main();
