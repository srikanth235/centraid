#!/usr/bin/env node
/**
 * I8 — re-stamp staged-rollout window on published electron-updater manifests.
 *
 * electron-updater admits installs using releaseDate (see update-rollout-core).
 * Widening the effective window for installs that already see a release means
 * making releaseDate *earlier* so elapsed time is larger (bucket < elapsed/window).
 *
 *   node scripts/release/restamp-rollout.mjs \
 *     --hours 72 \
 *     --yml path/to/latest-mac.yml \
 *     [--out path] [--dry-run]
 *
 * Pure YAML touch: only rewrites `releaseDate` (ISO). Never renames latest → beta.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Rewrite releaseDate in an electron-updater latest*.yml body.
 * @param {string} yml electron-updater YAML text
 * @param {number} hours hours to subtract from now (widen admit); 0 = set to now
 * @param {number} [nowMs] clock override for tests
 */
export function restampReleaseDate(yml, hours, nowMs = Date.now()) {
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error(`hours must be >= 0, got ${hours}`);
  }
  const target = new Date(nowMs - hours * 3600 * 1000).toISOString();
  if (!/releaseDate:/m.test(yml)) {
    const withDate = yml.replace(/^(version:\s*.+)$/m, `$1\nreleaseDate: '${target}'`);
    if (withDate === yml) {
      return { text: `${yml.trimEnd()}\nreleaseDate: '${target}'\n`, releaseDate: target };
    }
    return { text: withDate, releaseDate: target };
  }
  const text = yml.replace(/^releaseDate:\s*.+$/m, `releaseDate: '${target}'`);
  return { text, releaseDate: target };
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    const sample =
      "version: 0.1.0\npath: Centraid-0.1.0-arm64.dmg\nreleaseDate: '2020-01-01T00:00:00.000Z'\n";
    const { text, releaseDate } = restampReleaseDate(
      sample,
      72,
      Date.parse('2026-01-10T12:00:00.000Z'),
    );
    if (!text.includes(releaseDate)) {
      console.error('self-test failed');
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, releaseDate }));
    process.exit(0);
  }

  let hours = null;
  let ymlPath = null;
  let outPath = null;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hours') hours = Number(args[++i]);
    else if (args[i] === '--yml') ymlPath = args[++i];
    else if (args[i] === '--out') outPath = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
  }

  if (hours == null || !ymlPath) {
    console.error('usage: restamp-rollout.mjs --hours N --yml <file> [--out <file>] [--dry-run]');
    process.exit(2);
  }
  if (!existsSync(ymlPath)) {
    console.error(`missing yml: ${ymlPath}`);
    process.exit(1);
  }

  const src = readFileSync(ymlPath, 'utf8');
  const { text, releaseDate } = restampReleaseDate(src, hours);
  const dest = outPath || ymlPath;
  if (!dryRun) writeFileSync(dest, text);
  console.log(JSON.stringify({ yml: ymlPath, out: dest, hours, releaseDate, dryRun }, null, 2));
}
