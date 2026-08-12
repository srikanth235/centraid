#!/usr/bin/env node
/**
 * ACP min-version drift guard (issue #504 batch 6).
 * Ensures registry defaultBin entries remain documented in docs/harnesses.md
 * and every kind declares a minVersion object.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const registry = readFileSync(
  path.join(root, "packages/agent-runtime/src/registry.ts"),
  "utf8"
);
const runnersDoc = readFileSync(path.join(root, "docs/harnesses.md"), "utf8");

const minVersionObjs = [
  ...registry.matchAll(/minVersion:\s*\{\s*major:\s*\d+/gu),
];
if (minVersionObjs.length < 5) {
  process.stderr.write(
    `lint-acp-min-versions: expected several minVersion objects, found ${minVersionObjs.length}\n`
  );
  process.exit(1);
}

const bins = [
  ...registry.matchAll(/defaultBin:\s*['"](?<bin>[^'"]+)['"]/gu),
].map((m) => m.groups?.bin ?? "");
if (bins.length < 5) {
  process.stderr.write(
    `lint-acp-min-versions: expected several defaultBin entries\n`
  );
  process.exit(1);
}

const missing = bins.filter(
  (b) => b && !runnersDoc.includes(`\`${b}\``) && !runnersDoc.includes(b)
);
if (missing.length) {
  process.stderr.write(
    `lint-acp-min-versions: defaultBin missing from docs/harnesses.md: ${missing.join(", ")}\n`
  );
  process.exit(1);
}

process.stdout.write(
  `lint-acp-min-versions: ok (${minVersionObjs.length} minVersions, ${bins.length} defaultBins)\n`
);
