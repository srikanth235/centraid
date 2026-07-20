#!/usr/bin/env node
/**
 * D3 — extract CHANGELOG section for a version as GitHub Release body.
 *   node scripts/release/changelog-to-github.mjs --version 0.2.1 [--out path]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let version = null;
let out = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--version') version = args[++i];
  else if (args[i] === '--out') out = args[++i];
}
if (!version) {
  console.error('usage: node scripts/release/changelog-to-github.mjs --version X.Y.Z');
  process.exit(2);
}
const text = readFileSync(path.resolve('CHANGELOG.md'), 'utf8');
const re = new RegExp(
  `^##\\s+\\[${version.replace(/\./g, '\\.')}\\][^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|$)`,
  'm',
);
const m = text.match(re);
const body = (m?.[1] ?? `Centraid ${version}\n`).trim() + '\n';
if (out) writeFileSync(out, body);
else process.stdout.write(body);
