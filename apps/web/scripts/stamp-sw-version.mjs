#!/usr/bin/env node
/**
 * K8 — stamp public/sw.js VERSION from the single source apps/web/src/sw-version.ts.
 * Run before vite build so the service worker cache token cannot drift from the
 * page's register ?v= token.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = readFileSync(path.join(root, 'src/sw-version.ts'), 'utf8');
const m = src.match(/SERVICE_WORKER_VERSION\s*=\s*['"](?<version>[^'"]+)['"]/u);
if (!m) {
  console.error('stamp-sw-version: could not parse SERVICE_WORKER_VERSION from sw-version.ts');
  process.exit(1);
}
const version = m.groups.version;
const swPath = path.join(root, 'public/sw.js');
let sw = readFileSync(swPath, 'utf8');
// Single-quoted assignment so oxfmt --check stays clean after stamp (CI static).
const assignment = `const VERSION = '${version.replace(/'/gu, "\\'")}'`;
const next = sw.replace(/const VERSION = ['"][^'"]*['"]/u, assignment);
if (next === sw && !sw.includes(assignment)) {
  console.error('stamp-sw-version: VERSION assignment not found in public/sw.js');
  process.exit(1);
}
writeFileSync(swPath, next);
console.log(`stamp-sw-version: public/sw.js VERSION = ${version}`);
