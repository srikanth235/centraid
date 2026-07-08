#!/usr/bin/env node
/**
 * Assemble the deployable site tree that wrangler.json serves
 * (assets.directory = ./dist/site):
 *   dist/site/       ← home landing (scripts/home-site/public)
 *   dist/site/docs/  ← docs (dist/docs-site, built with base /docs)
 * plus an authoritative root _headers whose rules are site-absolute.
 *
 * Run after the docs build. `bun run docs:bundle` chains the two, and that is
 * the build command Cloudflare runs before `wrangler deploy` — deployment lives
 * in Cloudflare's Git integration, not in a GitHub Actions job.
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const docsOut = join(repoRoot, 'dist', 'docs-site');
const homePublic = join(repoRoot, 'scripts', 'home-site', 'public');
const siteDir = join(repoRoot, 'dist', 'site');

// Cloudflare Workers static assets reads ONE _headers at the assets root; its
// rules are site-absolute, so they must carry the /docs/ prefix of the combined
// tree (the inert copy at dist/site/docs/_headers is ignored).
//
// Cloudflare COMBINES every matching rule (it does not do most-specific-wins),
// so a header set on both /* and a narrower rule concatenates into one value.
// To keep it clean: set Cache-Control ONLY on the non-overlapping asset
// prefixes, and let /* own the security headers (and, by being the only rule
// that matches HTML, HTML's caching — via Cloudflare's short-lived default).
const headers = `# Pagefind search bundle — hashed filenames, safe to pin forever.
/docs/pagefind/*
  Cache-Control: public, max-age=31536000, immutable

# docs.css/docs.js carry a ?v=<contenthash>, so a long cache is safe; any
# other (unhashed) asset here refreshes within the day.
/docs/assets/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=600

# Security headers for every response. Cache-Control is deliberately omitted:
# setting it here would concatenate onto the asset rules above. HTML matches
# only this rule and falls back to Cloudflare's default (revalidated) caching.
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`;

await rm(siteDir, { recursive: true, force: true });
await mkdir(join(siteDir, 'docs'), { recursive: true });
await cp(homePublic, siteDir, { recursive: true });
await cp(docsOut, join(siteDir, 'docs'), { recursive: true });
await writeFile(join(siteDir, '_headers'), headers, 'utf8');
console.log('docs-site bundle: assembled dist/site (home + /docs) with _headers');
