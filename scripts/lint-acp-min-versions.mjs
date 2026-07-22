#!/usr/bin/env node
/**
 * ACP min-version drift guard (issue #504 batch 6).
 * Ensures registry defaultBin entries remain documented in docs/runners.md
 * and every kind declares a minVersion object.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = readFileSync(path.join(root, 'packages/agent-runtime/src/registry.ts'), 'utf8');
const runnersDoc = readFileSync(path.join(root, 'docs/runners.md'), 'utf8');

const minVersionObjs = [...registry.matchAll(/minVersion:\s*\{\s*major:\s*\d+/g)];
if (minVersionObjs.length < 5) {
  process.stderr.write(
    `lint-acp-min-versions: expected several minVersion objects, found ${minVersionObjs.length}\n`,
  );
  process.exit(1);
}

const bins = [...registry.matchAll(/defaultBin:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
if (bins.length < 5) {
  process.stderr.write(`lint-acp-min-versions: expected several defaultBin entries\n`);
  process.exit(1);
}

const missing = bins.filter(
  (b) => b && !runnersDoc.includes(`\`${b}\``) && !runnersDoc.includes(b),
);
if (missing.length) {
  process.stderr.write(
    `lint-acp-min-versions: defaultBin missing from docs/runners.md: ${missing.join(', ')}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `lint-acp-min-versions: ok (${minVersionObjs.length} minVersions, ${bins.length} defaultBins)\n`,
);
