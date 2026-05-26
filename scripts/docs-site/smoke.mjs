#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const site = path.join(root, 'dist', 'docs-site');
const expectedOrigin = (
  process.env.DOCS_SITE_CANONICAL_ORIGIN ??
  (process.env.DOCS_SITE_CNAME
    ? `https://${process.env.DOCS_SITE_CNAME}`
    : 'https://docs.centraid.dev')
).replace(/\/$/, '');
const previewOrigin = (
  process.env.DOCS_SITE_CNAME
    ? `https://${process.env.DOCS_SITE_CNAME}`
    : 'https://docs.centraid.dev'
).replace(/\/$/, '');
const artifactMode = process.env.DOCS_SITE_ARTIFACT_MODE ?? 'full';
const shellOnly = artifactMode === 'shell';
if (!['full', 'shell'].includes(artifactMode)) {
  throw new Error(`DOCS_SITE_ARTIFACT_MODE must be full or shell, got ${artifactMode}`);
}

const required = [
  'index.html',
  'getting-started/index.html',
  '__elements/index.html',
  'assets/docs-site.css',
  'assets/docs-site.js',
  'assets/mermaid.esm.min.mjs',
  'assets/svg-pan-zoom.min.js',
  'assets/centraid-mark.svg',
];
if (!shellOnly) {
  required.push(
    'llms.txt',
    '.well-known/llms.txt',
    'robots.txt',
    'sitemap.xml',
    'pagefind/pagefind.js',
    'og-card.png',
  );
}

const poison = [
  /\banalysis\s+to=functions\./iu,
  /\b(?:commentary|final)\s+to=functions\./iu,
  /\bfunctions\.(?:read|write|exec|search|run)\b/iu,
  /CENTRAID_DOCS_MARKER/u,
  /<\/?centraid_docs_i18n_input>/iu,
  /\/home\/runner\/work\//u,
];

for (const rel of required) {
  const file = path.join(site, rel);
  if (!fs.existsSync(file)) throw new Error(`missing ${rel}`);
  if (!rel.endsWith('.html')) continue;
  const html = fs.readFileSync(file, 'utf8');
  if (!/<title>[^<]+<\/title>/i.test(html)) throw new Error(`${rel}: missing title`);
  for (const pattern of poison) {
    if (pattern.test(html)) throw new Error(`${rel}: poison matched ${pattern}`);
  }
}

const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
if (!index.includes(`<link rel="canonical" href="${expectedOrigin}/">`)) {
  throw new Error(`index: canonical link should use ${expectedOrigin}`);
}
if (!index.includes(`<meta property="og:url" content="${expectedOrigin}/">`)) {
  throw new Error(`index: og:url should use ${expectedOrigin}`);
}
if (previewOrigin !== expectedOrigin && index.includes(previewOrigin)) {
  throw new Error(`index: preview origin ${previewOrigin} should not be advertised`);
}
if (!/class="breadcrumbs"/.test(index) || !/data-copy-page/.test(index)) {
  throw new Error('index: page reader affordances are missing');
}

const cssVersion = index.match(/href="[^"]*\/assets\/docs-site\.css\?v=([a-f0-9]{12})"/)?.[1];
const jsVersion = index.match(/src="[^"]*\/assets\/docs-site\.js\?v=([a-f0-9]{12})"/)?.[1];
if (!process.env.DOCS_SITE_BASE_PATH && !cssVersion) {
  throw new Error('index: custom-domain build did not emit root asset paths');
}
if (!jsVersion || cssVersion !== jsVersion) {
  throw new Error('index: docs shell assets do not share a content version');
}

const siteCss = fs.readFileSync(path.join(site, 'assets/docs-site.css'), 'utf8');
const siteJs = fs.readFileSync(path.join(site, 'assets/docs-site.js'), 'utf8');

if (!/\.cd-card/.test(siteCss) || !/\.cd-step/.test(siteCss) || !/\.cd-code/.test(siteCss)) {
  throw new Error('assets: cd- component styles are missing from site css');
}
if (!/function syncSidebar/.test(siteJs) || !/async function navigateTo/.test(siteJs)) {
  throw new Error('assets: docs PJAX navigation is missing');
}
if (!/function runSearch/.test(siteJs)) {
  throw new Error('assets: search runtime is missing');
}

if (!shellOnly) {
  const llms = fs.readFileSync(path.join(site, 'llms.txt'), 'utf8');
  if (!/Accept: text\/markdown|\.md/.test(llms)) {
    throw new Error('llms.txt: should advertise page-level Markdown');
  }
  if (!llms.includes(`${expectedOrigin}/sitemap.xml`)) {
    throw new Error(`llms.txt: expected canonical origin ${expectedOrigin}`);
  }
  const wellKnownLlms = fs.readFileSync(path.join(site, '.well-known/llms.txt'), 'utf8');
  if (wellKnownLlms !== llms) throw new Error('.well-known/llms.txt: does not match root llms.txt');

  const robots = fs.readFileSync(path.join(site, 'robots.txt'), 'utf8');
  if (!robots.includes(`Sitemap: ${expectedOrigin}/sitemap.xml`)) {
    throw new Error(`robots.txt: sitemap directive missing canonical origin ${expectedOrigin}`);
  }
  if (!robots.includes(`LLMS: ${expectedOrigin}/llms.txt`)) {
    throw new Error('robots.txt: LLMS directive missing');
  }

  const sitemap = fs.readFileSync(path.join(site, 'sitemap.xml'), 'utf8');
  if (!sitemap.includes(`<loc>${expectedOrigin}/`)) {
    throw new Error(`sitemap.xml: expected canonical origin ${expectedOrigin}`);
  }

  if (
    /\/__elements/.test(fs.readFileSync(path.join(site, 'sitemap.xml'), 'utf8')) ||
    /\/__elements/.test(fs.readFileSync(path.join(site, 'llms.txt'), 'utf8'))
  ) {
    throw new Error('__elements: hidden component fixture leaked into public indexes');
  }
}

const elementsIndex = fs.readFileSync(path.join(site, '__elements/index.html'), 'utf8');
if (!/<meta name="robots" content="noindex,nofollow">/.test(elementsIndex)) {
  throw new Error('__elements: hidden component fixture should be noindex');
}
if (/data-pagefind-body/.test(elementsIndex) || !/data-pagefind-ignore/.test(elementsIndex)) {
  throw new Error('__elements: hidden component fixture should be excluded from Pagefind');
}

if (process.env.DOCS_SITE_CNAME) {
  const cnamePath = path.join(site, 'CNAME');
  if (
    !fs.existsSync(cnamePath) ||
    fs.readFileSync(cnamePath, 'utf8').trim() !== process.env.DOCS_SITE_CNAME
  ) {
    throw new Error('CNAME: custom domain file missing or wrong');
  }
}

console.log('docs smoke ok'); // governance: allow-repo-hygiene #119 — smoke-test exit signal
