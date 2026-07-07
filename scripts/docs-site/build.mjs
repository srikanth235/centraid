#!/usr/bin/env node
/**
 * Centraid docs build.
 *
 * Astro owns the authored docs pages and emits static HTML into
 * dist/docs-site. A second pass walks that output and distills a tiny
 * client-side search index (assets/search-index.json) — one entry per
 * anchored section — so the header search box works with no server.
 */
import { spawn } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

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

const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim();

async function buildSearchIndex() {
  const base = basePrefix();
  const pages = (await walk(outDir)).filter(
    (f) => f.endsWith('index.html') && !f.startsWith('404'),
  );

  const records = [];
  for (const page of pages) {
    const route = posix.dirname(page); // "start", "data", … or "." for root
    const href = route === '.' ? base : `${base}${route}/`;
    const dom = new JSDOM(await readFile(join(outDir, page), 'utf8'));
    const doc = dom.window.document;

    const rawTitle = collapse(doc.querySelector('title')?.textContent);
    const pageLabel = rawTitle.split('—')[0].trim() || rawTitle || route;
    const h1 = collapse(doc.querySelector('main h1')?.textContent);

    // Page-level entry (lands at the top of the page).
    records.push({
      title: h1 || pageLabel,
      page: pageLabel,
      kicker: '',
      href,
      text: collapse(doc.querySelector('main p:not(.eyebrow)')?.textContent).slice(0, 260),
    });

    // One entry per anchored section.
    for (const sec of doc.querySelectorAll('main section[id]')) {
      const heading = collapse(sec.querySelector('h1, h2, h3')?.textContent);
      if (!heading) continue;
      const kicker = collapse(sec.querySelector('.eyebrow')?.textContent);
      const text = collapse(sec.textContent)
        .replace(kicker, '')
        .replace(heading, '')
        .trim()
        .slice(0, 260);
      records.push({ title: heading, page: pageLabel, kicker, href: `${href}#${sec.id}`, text });
    }
  }

  await writeFile(join(outDir, 'assets', 'search-index.json'), JSON.stringify(records), 'utf8');
  console.log(`docs-site search: indexed ${records.length} sections across ${pages.length} pages`);
}

await run('bun', ['x', 'astro', 'build', '--config', 'astro.config.mjs']);
await buildSearchIndex();
