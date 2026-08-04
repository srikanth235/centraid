#!/usr/bin/env node
/**
 * Assemble the deployable site tree that wrangler.json serves
 * (assets.directory = ./dist/site):
 *   dist/site/       ← home landing (scripts/home-site/public)
 *   dist/site/docs/  ← docs (dist/docs-site, built with base /docs)
 *   dist/site/city/  ← City (centraid-city, built with base /city/)
 * plus an authoritative root _headers whose rules are site-absolute.
 *
 * Run after the docs build. `bun run docs:bundle` chains the two, and that is
 * the build command Cloudflare runs before `wrangler deploy` — deployment lives
 * in Cloudflare's Git integration, not in a GitHub Actions job.
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const docsOut = path.join(repoRoot, "dist", "docs-site");
const homePublic = path.join(repoRoot, "scripts", "home-site", "public");
const cityOut = path.join(repoRoot, "centraid-city", "dist");
const siteDir = path.join(repoRoot, "dist", "site");

// Cloudflare Workers static assets reads ONE _headers at the assets root; its
// rules are site-absolute, so they must carry the /docs/ prefix of the combined
// tree (the inert copy at dist/site/docs/_headers is ignored).
const headers = `# Pagefind search bundle — hashed filenames, safe to pin forever.
/docs/pagefind/*
  Cache-Control: public, max-age=31536000, immutable
  X-Content-Type-Options: nosniff

# docs.css/docs.js carry a ?v=<contenthash>, so a long cache is safe; any
# other (unhashed) asset here refreshes within the day.
/docs/assets/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=600
  X-Content-Type-Options: nosniff

# City assets are Vite-hashed and can be cached indefinitely.
/city/assets/*
  Cache-Control: public, max-age=31536000, immutable
  X-Content-Type-Options: nosniff

# HTML — short cache, revalidate often so shipped changes land fast.
/*
  Cache-Control: public, max-age=300, s-maxage=300, stale-while-revalidate=60
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`;

await rm(siteDir, { recursive: true, force: true });
await mkdir(path.join(siteDir, "docs"), { recursive: true });
await mkdir(path.join(siteDir, "city"), { recursive: true });
await cp(homePublic, siteDir, { recursive: true });
await cp(docsOut, path.join(siteDir, "docs"), { recursive: true });
await cp(cityOut, path.join(siteDir, "city"), { recursive: true });
await writeFile(path.join(siteDir, "_headers"), headers, "utf8");
console.log(
  "docs-site bundle: assembled dist/site (home + /docs + /city) with _headers"
);
