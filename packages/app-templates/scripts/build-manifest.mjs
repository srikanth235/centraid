#!/usr/bin/env node
/**
 * Generates `manifest.json` from `index.json` plus a directory walk of each
 * template's files.
 *
 * The runtime reads this manifest (both the bundled copy at the package root
 * and any cached copy in user-data). The bundled file is checked into git so
 * the same path on GitHub raw can serve as the remote manifest — no separate
 * publish step.
 *
 * Run via `bun run build:manifest` (or as part of `bun run build`).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(here, '..');
const SOURCE_INDEX = path.join(PACKAGE_ROOT, 'index.json');
const OUTPUT = path.join(PACKAGE_ROOT, 'manifest.json');

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else if (e.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out.toSorted();
}

const raw = await fs.readFile(SOURCE_INDEX, 'utf8');
const src = JSON.parse(raw);

const enriched = {
  manifestVersion: src.manifestVersion,
  templates: [],
};

for (const tmpl of src.templates) {
  const dir = path.join(PACKAGE_ROOT, tmpl.id);
  let files = [];
  try {
    files = await walk(dir);
  } catch {
    console.warn(`[build-manifest] missing template dir for "${tmpl.id}", skipping`);
    continue;
  }
  enriched.templates.push({ ...tmpl, files });
}

await fs.writeFile(OUTPUT, JSON.stringify(enriched, null, 2) + '\n');
console.log(
  `[build-manifest] wrote ${enriched.templates.length} templates → ${path.relative(process.cwd(), OUTPUT)}`,
);
