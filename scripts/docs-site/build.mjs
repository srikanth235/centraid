#!/usr/bin/env node
/**
 * Centraid docs build — static copy.
 *
 * The docs are hand-authored HTML/CSS in /docs (index, start, data, apps,
 * devices, ontology + assets/). There is no renderer, no MDX, no search
 * index: this script copies the site verbatim into dist/docs-site/ for the
 * Cloudflare Worker assets binding (wrangler.docs.toml) to serve.
 *
 * Excluded from the copy: markdown files and the plans/ directory — those
 * are repo-internal notes that live beside the site source, not on it.
 */
import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcDir = join(repoRoot, 'docs');
const outDir = join(repoRoot, 'dist', 'docs-site');

const EXCLUDED_DIRS = new Set(['plans']);
const EXCLUDED_EXTS = new Set(['.md', '.mdx']);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from)) {
    const src = join(from, entry);
    const info = await stat(src);
    if (info.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      await copyDir(src, join(to, entry));
    } else {
      if (EXCLUDED_EXTS.has(extname(entry))) continue;
      await cp(src, join(to, entry));
    }
  }
}

await copyDir(srcDir, outDir);

const pages = (await readdir(outDir)).filter((f) => f.endsWith('.html'));
console.log(`docs-site: copied ${pages.length} pages → ${outDir}`);
console.log(`  ${pages.sort().join('  ')}`);
