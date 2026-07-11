#!/usr/bin/env node
/**
 * Static checks on dist/docs-site — run after `bun run docs:build`.
 *
 *  1. Every expected clean route and shared asset exists.
 *  2. Every internal href/src in every page resolves to a file in the dist
 *     (anchors and external URLs skipped).
 *  3. Indexed pages carry the baseline SEO head: title, description, canonical,
 *     Open Graph, Twitter, and JSON-LD.
 *  4. The homepage links to canonical `/docs/<route>/` URLs, never the old
 *     docs subdomain or `.html` docs filenames.
 *  5. No page resurrects retired Duaility branding.
 */
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(repoRoot, 'dist', 'docs-site');
const homeIndex = join(repoRoot, 'scripts', 'home-site', 'public', 'index.html');

const REQUIRED = [
  'index.html',
  'start/index.html',
  'understand/index.html',
  'data/index.html',
  'apps/index.html',
  'devices/index.html',
  'backups/index.html',
  'ontology/index.html',
  '404.html',
  '_headers',
  'assets/docs.css',
  'assets/docs.js',
  'assets/centraid-mark.svg',
  'assets/og-docs.svg',
  'pagefind/pagefind.js',
];

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`x ${msg}`);
};

async function exists(rel) {
  try {
    await access(join(outDir, rel));
    return true;
  } catch {
    return false;
  }
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

async function resolves(clean, fromPage) {
  if (clean === '' || clean === './') return true;

  let candidate = clean;
  if (candidate.startsWith('/')) {
    const basePath = process.env.DOCS_SITE_BASE_PATH || '';
    candidate = candidate.replace(
      new RegExp(`^${basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`),
      '',
    );
    candidate = candidate.replace(/^\//, '');
  } else {
    candidate = posix.normalize(posix.join(posix.dirname(fromPage), candidate));
  }

  if (candidate === '.') candidate = 'index.html';
  if (candidate.endsWith('/')) candidate = `${candidate}index.html`;
  if (await exists(candidate)) return true;
  if (await exists(posix.join(candidate, 'index.html'))) return true;
  return false;
}

for (const rel of REQUIRED) {
  if (!(await exists(rel))) fail(`missing required file: ${rel}`);
}

const pages = (await walk(outDir)).filter((f) => f.endsWith('.html'));
const HREF_RE = /(?:href|src)="([^"]+)"/g;
const tagAttr = (html, tag, attr, value, readAttr = 'content') => {
  const re = new RegExp(
    `<${tag}\\b(?=[^>]*\\b${attr}="${value}")[^>]*\\b${readAttr}="([^"]*)"[^>]*>`,
    'i',
  );
  return html.match(re)?.[1] || '';
};
const titleValues = new Map();
const descriptionValues = new Map();

for (const page of pages) {
  const html = await readFile(join(outDir, page), 'utf8');

  if (/duaility/i.test(html)) fail(`${page}: retired "Duaility" branding still present`);

  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || '';
  const description = tagAttr(html, 'meta', 'name', 'description');
  const noIndex = /<meta\b(?=[^>]*\bname="robots")(?=[^>]*\bcontent="[^"]*noindex)/i.test(html);

  if (!title) fail(`${page}: missing <title>`);
  if (title.length > 70)
    fail(`${page}: <title> is too long for a clean search result (${title.length})`);
  if (!description) fail(`${page}: missing meta description`);

  if (!noIndex) {
    if (description && (description.length < 80 || description.length > 170)) {
      fail(
        `${page}: meta description should stay between 80 and 170 characters (${description.length})`,
      );
    }
    const canonical = tagAttr(html, 'link', 'rel', 'canonical', 'href');
    if (!canonical) fail(`${page}: missing canonical link`);
    if (canonical && !canonical.startsWith('https://centraid.dev/docs/')) {
      fail(`${page}: canonical must stay under https://centraid.dev/docs/`);
    }
    if (!tagAttr(html, 'meta', 'property', 'og:title')) fail(`${page}: missing og:title`);
    if (!tagAttr(html, 'meta', 'property', 'og:description'))
      fail(`${page}: missing og:description`);
    if (!tagAttr(html, 'meta', 'property', 'og:url')) fail(`${page}: missing og:url`);
    if (!tagAttr(html, 'meta', 'property', 'og:image')) fail(`${page}: missing og:image`);
    if (!tagAttr(html, 'meta', 'name', 'twitter:card')) fail(`${page}: missing twitter:card`);
    if (!tagAttr(html, 'meta', 'name', 'twitter:image')) fail(`${page}: missing twitter:image`);
    if (!/<main\b[^>]*data-pagefind-body(?:[=>\s]|$)/.test(html)) {
      fail(`${page}: missing Pagefind body marker`);
    }
    if (!/<meta\b(?=[^>]*\bdata-pagefind-meta="label\[content\]")/.test(html)) {
      fail(`${page}: missing Pagefind label metadata`);
    }
    if (!/<script\b[^>]*type="application\/ld\+json"[^>]*>/.test(html)) {
      fail(`${page}: missing JSON-LD structured data`);
    }
    if (titleValues.has(title))
      fail(`${page}: duplicate SEO title also used by ${titleValues.get(title)}`);
    else titleValues.set(title, page);
    if (descriptionValues.has(description)) {
      fail(
        `${page}: duplicate meta description also used by ${descriptionValues.get(description)}`,
      );
    } else {
      descriptionValues.set(description, page);
    }
  }

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
    if (!(await resolves(clean, page))) fail(`${page}: broken internal link -> ${url}`);
  }
}

const homeHtml = await readFile(homeIndex, 'utf8');
if (/https:\/\/docs\.centraid\.dev/.test(homeHtml)) {
  fail('home-site index.html: production docs links must stay under /docs/');
}
if (/href="\/docs\/(?:start|data|apps|devices|backups|ontology)\.html(?:#.*?)?"/.test(homeHtml)) {
  fail('home-site index.html: docs links must use clean /docs/<route>/ URLs');
}

if (failures) {
  console.error(`docs-site smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`docs-site smoke: ${pages.length} pages OK, all internal links resolve`);
