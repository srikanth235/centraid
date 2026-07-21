#!/usr/bin/env node
/**
 * Centraid docs build.
 *
 * Astro owns the authored docs pages and emits static HTML into
 * dist/docs-site. A second pass normalizes section anchors for Pagefind and
 * runs Pagefind over that output so the header search box gets a durable
 * static full-text index with no server.
 */
import { spawn } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as pagefind from 'pagefind';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(repoRoot, 'dist', 'docs-site');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

// The site is served under DOCS_SITE_BASE_PATH (e.g. "/docs" on the apex
// domain, "/" locally) — the same value astro.config.mjs feeds Astro's `base`.
// Bake it into the index hrefs so results link correctly in both trees.
function basePrefix() {
  const raw = process.env.DOCS_SITE_BASE_PATH || '/';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

async function walk(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir)) {
    const abs = join(dir, entry);
    const rel = prefix ? posix.join(prefix, entry) : entry;
    const info = await stat(abs);
    if (info.isDirectory()) out.push(...(await walk(abs, rel)));
    else out.push(rel);
  }
  return out;
}

async function normalizePagefindAnchors() {
  const pages = (await walk(outDir)).filter((f) => f.endsWith('.html'));
  let moved = 0;
  for (const page of pages) {
    const abs = join(outDir, page);
    const dom = new JSDOM(await readFile(abs, 'utf8'));
    const doc = dom.window.document;
    let changed = false;

    for (const section of doc.querySelectorAll('main section[id]')) {
      const id = section.getAttribute('id');
      const heading = section.querySelector('h1, h2, h3, h4, h5, h6');
      if (!id || !heading || heading.id) continue;
      heading.id = id;
      section.removeAttribute('id');
      changed = true;
      moved += 1;
    }

    if (changed) {
      await writeFile(abs, `<!doctype html>\n${doc.documentElement.outerHTML}`, 'utf8');
    }
  }
  console.log(`docs-site search: moved ${moved} section anchors onto headings`);
}

async function buildSearchIndex() {
  // Pagefind's Node API instead of `bun x pagefind` — the dependency is now a
  // real import the lockfile pins and knip can trace, not an opaque subprocess.
  // Flag parity with the old CLI call: --force-language en, --include-characters
  // '._:/<>-', --site outDir (addDirectory), --output-subdir pagefind
  // (writeFiles outputPath). --quiet maps to the API's default (no logging).
  const { errors, index } = await pagefind.createIndex({
    forceLanguage: 'en',
    includeCharacters: '._:/<>-',
  });
  if (errors.length > 0 || !index) {
    throw new Error(`pagefind: createIndex failed — ${errors.join('; ')}`);
  }
  await index.addDirectory({ path: outDir });
  await index.writeFiles({ outputPath: join(outDir, 'pagefind') });
  await pagefind.close();
  console.log(`docs-site search: Pagefind index built for ${basePrefix()} routes`);
}

await run('bun', ['x', 'astro', 'build', '--config', 'astro.config.mjs']);
await normalizePagefindAnchors();
await buildSearchIndex();
