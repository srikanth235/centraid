#!/usr/bin/env node
/**
 * Merge multi-platform tunnel NAPI artifacts into packages/tunnel/native/ (#511).
 *
 * Usage:
 *   node scripts/gateway-npm/merge-native-artifacts.mjs --from <dir> [--require]
 *
 * Expects `--from` to contain either:
 *   - flat: centraid-tunnel-native.*.node
 *   - or per-platform subdirs: linux-x64/*.node, darwin-arm64/*.node, …
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NATIVE_PLATFORMS,
  auditNativeArtifacts,
  nativeArtifactNameForId,
  requiredNativePlatformIds,
} from './native-platforms.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DEST = path.join(ROOT, 'packages/tunnel/native');

function parseArgs(argv) {
  let from = null;
  let require = process.env.CENTRAID_REQUIRE_MULTI_NATIVE === '1';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') from = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--require') require = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(
        'Usage: node scripts/gateway-npm/merge-native-artifacts.mjs --from <dir> [--require]',
      );
      process.exit(0);
    }
  }
  if (!from) {
    console.error('error: --from <dir> is required');
    process.exit(2);
  }
  return { from, require };
}

/**
 * @param {string} from Root directory to walk for .node files.
 * @returns {string[]} Absolute paths of .node files to copy.
 */
export function collectNodeArtifacts(from) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(from)) return out;

  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.node')) out.push(full);
    }
  };
  walk(from);
  return out;
}

/**
 * @param {string[]} sources Absolute paths of .node files.
 * @param {string} destDir Destination native/ directory.
 * @returns {string[]} Copied basenames.
 */
export function copyArtifacts(sources, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  /** @type {string[]} */
  const copied = [];
  for (const src of sources) {
    const base = path.basename(src);
    if (!base.startsWith('centraid-tunnel-native.') || !base.endsWith('.node')) {
      console.warn(`  skip unexpected artifact: ${base}`);
      continue;
    }
    const dest = path.join(destDir, base);
    fs.copyFileSync(src, dest);
    copied.push(base);
    console.log(`  + ${base}`);
  }
  return copied;
}

function main() {
  const { from, require } = parseArgs(process.argv.slice(2));
  console.log(`merge-native-artifacts: from=${from} → ${DEST}`);
  const sources = collectNodeArtifacts(from);
  if (sources.length === 0) {
    console.error(`error: no .node artifacts under ${from}`);
    process.exit(1);
  }
  const copied = copyArtifacts(sources, DEST);

  // Also list what is already in DEST (host build may have left one file)
  const present = fs
    .readdirSync(DEST)
    .filter((n) => n.endsWith('.node') && n.startsWith('centraid-tunnel-native.'));
  const audit = auditNativeArtifacts(present, {
    requiredIds: requiredNativePlatformIds(),
  });
  console.log(`present (${audit.present.length}): ${audit.present.join(', ') || '(none)'}`);
  if (audit.missingRequired.length) {
    const msg = `missing required native artifacts: ${audit.missingRequired.join(', ')}`;
    if (require) {
      console.error(`error: ${msg}`);
      console.error(`required ids: ${requiredNativePlatformIds().join(', ')}`);
      console.error(`known platforms: ${NATIVE_PLATFORMS.map((p) => p.id).join(', ')}`);
      process.exit(1);
    }
    console.warn(`warn: ${msg} (pass --require or CENTRAID_REQUIRE_MULTI_NATIVE=1 to fail)`);
  }
  // Touch a small manifest for pack debugging
  const manifestPath = path.join(DEST, 'native-platforms.manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        mergedAt: new Date().toISOString(),
        copied,
        present: audit.present,
        missingRequired: audit.missingRequired,
        required: requiredNativePlatformIds().map((id) => ({
          id,
          file: nativeArtifactNameForId(id),
        })),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`merge-native-artifacts: ok`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
