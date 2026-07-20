#!/usr/bin/env node
/**
 * K8 — stamp public/sw.js VERSION from the single source apps/web/src/sw-version.ts.
 * Run before vite build so the service worker cache token cannot drift from the
 * page's register ?v= token.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'src/sw-version.ts'), 'utf8');
const m = src.match(/SERVICE_WORKER_VERSION\s*=\s*['"]([^'"]+)['"]/);
if (!m) {
  console.error('stamp-sw-version: could not parse SERVICE_WORKER_VERSION from sw-version.ts');
  process.exit(1);
}
const version = m[1];
const swPath = path.join(root, 'public/sw.js');
let sw = readFileSync(swPath, 'utf8');
const next = sw.replace(
  /const VERSION = ['"][^'"]*['"]/,
  `const VERSION = ${JSON.stringify(version)}`,
);
if (next === sw && !sw.includes(`const VERSION = ${JSON.stringify(version)}`)) {
  console.error('stamp-sw-version: VERSION assignment not found in public/sw.js');
  process.exit(1);
}
writeFileSync(swPath, next);
console.log(`stamp-sw-version: public/sw.js VERSION = ${version}`);
