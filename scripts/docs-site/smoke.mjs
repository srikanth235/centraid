#!/usr/bin/env node
/**
 * Static checks on dist/docs-site — run after `bun run docs:build`.
 *
 *  1. Every expected page and shared asset exists.
 *  2. Every internal href/src in every page resolves to a file in the dist
 *     (anchors and external URLs skipped).
 *  3. No page still links the dead MDX-era URL space (/docs/...) or the
 *     retired Duaility branding.
 */
import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'docs-site');

const REQUIRED = [
  'index.html',
  'start.html',
  'data.html',
  'apps.html',
  'devices.html',
  'ontology.html',
  '404.html',
  '_headers',
  'assets/docs.css',
  'assets/docs.js',
  'assets/centraid-mark.svg',
];

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`✗ ${msg}`);
};

for (const rel of REQUIRED) {
  try {
    await access(join(outDir, rel));
  } catch {
    fail(`missing required file: ${rel}`);
  }
}

const pages = (await readdir(outDir)).filter((f) => f.endsWith('.html'));
const HREF_RE = /(?:href|src)="([^"]+)"/g;

for (const page of pages) {
  const html = await readFile(join(outDir, page), 'utf8');

  if (/duaility/i.test(html)) fail(`${page}: retired "Duaility" branding still present`);
  if (/href="\/docs\//.test(html)) fail(`${page}: links into the dead /docs/ MDX URL space`);

  for (const [, url] of html.matchAll(HREF_RE)) {
    if (
      url.startsWith('http') ||
      url.startsWith('#') ||
      url.startsWith('mailto:') ||
      url.startsWith('data:')
    ) {
      continue;
    }
    const clean = url.split('#')[0].split('?')[0];
    if (clean === '' || clean === './') continue;
    try {
      await access(join(outDir, clean));
    } catch {
      fail(`${page}: broken internal link → ${url}`);
    }
  }
}

if (failures) {
  console.error(`docs-site smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`docs-site smoke: ${pages.length} pages OK, all internal links resolve`);
