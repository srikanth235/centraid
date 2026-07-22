#!/usr/bin/env node
/**
 * Structural smoke for the continuous web PWA build (issue #501).
 * Asserts apps/web/dist has installable surface after `bun run web:build`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'apps/web/dist');
let failed = 0;

function ok(cond, msg) {
  if (cond) console.log(`PASS  ${msg}`);
  else {
    console.error(`FAIL  ${msg}`);
    failed++;
  }
}

ok(existsSync(dist), 'apps/web/dist exists (run bun run web:build first)');
ok(existsSync(path.join(dist, 'index.html')), 'index.html');
ok(existsSync(path.join(dist, 'sw.js')), 'sw.js');
ok(existsSync(path.join(dist, 'manifest.webmanifest')), 'manifest.webmanifest');

if (existsSync(path.join(dist, 'manifest.webmanifest'))) {
  const m = JSON.parse(readFileSync(path.join(dist, 'manifest.webmanifest'), 'utf8'));
  ok(m.id === '/' || m.id === undefined || m.id === '', 'manifest id is / (K5) or default');
  if (m.id !== undefined) ok(m.id === '/', 'manifest.id is "/" (K5 sticky install identity)');
}

const headers = path.join(root, 'apps/web/public/_headers');
ok(existsSync(headers), 'public/_headers present for CF assets');
if (existsSync(headers)) {
  const h = readFileSync(headers, 'utf8');
  ok(h.includes('sw.js'), '_headers mentions sw.js');
}

const wrangler = path.join(root, 'apps/web/wrangler.json');
ok(existsSync(wrangler), 'apps/web/wrangler.json present');

process.exit(failed > 0 ? 1 : 0);
