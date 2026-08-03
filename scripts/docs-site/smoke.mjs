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
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const { join, posix } = path;

const repoRoot = join(import.meta.dirname, "..", "..");
const outDir = join(repoRoot, "dist", "docs-site");
const siteDir = join(repoRoot, "dist", "site");
const homeIndex = join(
  repoRoot,
  "scripts",
  "home-site",
  "public",
  "index.html"
);

const REQUIRED = [
  "index.html",
  "start/index.html",
  "understand/index.html",
  "data/index.html",
  "apps/index.html",
  "devices/index.html",
  "backups/index.html",
  "privacy/index.html",
  "terms/index.html",
  "ontology/index.html",
  "404.html",
  "_headers",
  "assets/docs.css",
  "assets/docs.js",
  "assets/centraid-mark.svg",
  "assets/og-docs.svg",
  "pagefind/pagefind.js",
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

async function siteExists(rel) {
  try {
    await access(join(siteDir, rel));
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, prefix = "") {
  const entries = await readdir(dir);
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const abs = join(dir, entry);
        const rel = prefix ? posix.join(prefix, entry) : entry;
        const info = await stat(abs);
        return info.isDirectory() ? walk(abs, rel) : [rel];
      })
    )
  ).flat();
}

async function resolves(clean, fromPage) {
  if (clean === "" || clean === "./") return true;

  let candidate = clean;
  if (candidate.startsWith("/")) {
    const basePath = process.env.DOCS_SITE_BASE_PATH || "";
    candidate = candidate.replace(
      new RegExp(`^${basePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/?`, "u"),
      ""
    );
    candidate = candidate.replace(/^\//u, "");
  } else {
    candidate = posix.normalize(posix.join(posix.dirname(fromPage), candidate));
  }

  if (candidate === ".") candidate = "index.html";
  if (candidate.endsWith("/")) candidate = `${candidate}index.html`;
  if (await exists(candidate)) return true;
  if (await exists(posix.join(candidate, "index.html"))) return true;
  return false;
}

const required = await Promise.all(
  REQUIRED.map(async (rel) => ({ rel, exists: await exists(rel) }))
);
for (const { rel, exists: present } of required) {
  if (!present) fail(`missing required file: ${rel}`);
}

const pages = (await walk(outDir)).filter((f) => f.endsWith(".html"));
const HREF_RE = /(?:href|src)="(?<url>[^"]+)"/gu;
const tagAttr = (html, tag, attr, value, readAttr = "content") => {
  const re = new RegExp(
    `<${tag}\\b(?=[^>]*\\b${attr}="${value}")[^>]*\\b${readAttr}="(?<attrValue>[^"]*)"[^>]*>`,
    "iu"
  );
  return html.match(re)?.groups?.attrValue || "";
};
const titleValues = new Map();
const descriptionValues = new Map();

// Page validation records duplicate titles/descriptions against the first page
// encountered. Keep that reporting order deterministic even though each page's
// link checks fan out below.
const validatePage = async (index) => {
  const page = pages[index];
  if (!page) return;
  const html = await readFile(join(outDir, page), "utf8");

  if (/duaility/iu.test(html))
    fail(`${page}: retired "Duaility" branding still present`);

  const title =
    html
      .match(/<title>(?<titleText>[^<]+)<\/title>/iu)
      ?.groups?.titleText?.trim() || "";
  const description = tagAttr(html, "meta", "name", "description");
  const noIndex =
    /<meta\b(?=[^>]*\bname="robots")(?=[^>]*\bcontent="[^"]*noindex)/iu.test(
      html
    );

  if (!title) fail(`${page}: missing <title>`);
  if (title.length > 70)
    fail(
      `${page}: <title> is too long for a clean search result (${title.length})`
    );
  if (!description) fail(`${page}: missing meta description`);

  if (!noIndex) {
    if (description && (description.length < 80 || description.length > 170)) {
      fail(
        `${page}: meta description should stay between 80 and 170 characters (${description.length})`
      );
    }
    const canonical = tagAttr(html, "link", "rel", "canonical", "href");
    if (!canonical) fail(`${page}: missing canonical link`);
    if (canonical && !canonical.startsWith("https://centraid.dev/docs/")) {
      fail(`${page}: canonical must stay under https://centraid.dev/docs/`);
    }
    if (!tagAttr(html, "meta", "property", "og:title"))
      fail(`${page}: missing og:title`);
    if (!tagAttr(html, "meta", "property", "og:description"))
      fail(`${page}: missing og:description`);
    if (!tagAttr(html, "meta", "property", "og:url"))
      fail(`${page}: missing og:url`);
    if (!tagAttr(html, "meta", "property", "og:image"))
      fail(`${page}: missing og:image`);
    if (!tagAttr(html, "meta", "name", "twitter:card"))
      fail(`${page}: missing twitter:card`);
    if (!tagAttr(html, "meta", "name", "twitter:image"))
      fail(`${page}: missing twitter:image`);
    if (!/<main\b[^>]*data-pagefind-body(?:[=>\s]|$)/u.test(html)) {
      fail(`${page}: missing Pagefind body marker`);
    }
    if (
      !/<meta\b(?=[^>]*\bdata-pagefind-meta="label\[content\]")/u.test(html)
    ) {
      fail(`${page}: missing Pagefind label metadata`);
    }
    if (!/<script\b[^>]*type="application\/ld\+json"[^>]*>/u.test(html)) {
      fail(`${page}: missing JSON-LD structured data`);
    }
    if (titleValues.has(title))
      fail(
        `${page}: duplicate SEO title also used by ${titleValues.get(title)}`
      );
    else titleValues.set(title, page);
    if (descriptionValues.has(description)) {
      fail(
        `${page}: duplicate meta description also used by ${descriptionValues.get(description)}`
      );
    } else {
      descriptionValues.set(description, page);
    }
  }

  await Promise.all(
    [...html.matchAll(HREF_RE)].map(async (href) => {
      const url = href.groups?.url ?? "";
      if (
        url.startsWith("http") ||
        url.startsWith("#") ||
        url.startsWith("mailto:") ||
        url.startsWith("data:")
      ) {
        return;
      }
      const clean = url.split("#")[0].split("?")[0];
      if (!(await resolves(clean, page)))
        fail(`${page}: broken internal link -> ${url}`);
    })
  );
  return validatePage(index + 1);
};
await validatePage(0);

const homeHtml = await readFile(homeIndex, "utf8");
if (/https:\/\/docs\.centraid\.dev/u.test(homeHtml)) {
  fail("home-site index.html: production docs links must stay under /docs/");
}
if (
  /href="\/docs\/(?:start|data|apps|devices|backups|ontology)\.html(?:#.*?)?"/u.test(
    homeHtml
  )
) {
  fail("home-site index.html: docs links must use clean /docs/<route>/ URLs");
}

const siteHomeIndex = "index.html";
if (await siteExists(siteHomeIndex)) {
  const siteHomeHtml = await readFile(join(siteDir, siteHomeIndex), "utf8");
  if (!/<a\b[^>]*href="city\/"[^>]*>city<\/a>/u.test(siteHomeHtml)) {
    fail("assembled site: homepage is missing the city navigation tab");
  }
  if (await siteExists("city/index.html")) {
    const cityHtml = await readFile(
      join(siteDir, "city", "index.html"),
      "utf8"
    );
    if (!/<script\b[^>]*src="\/city\/assets\/[^" ]+\.js"/u.test(cityHtml)) {
      fail("assembled site: city assets are not rooted under /city/");
    }
  } else {
    fail("assembled site: missing /city/ index");
  }
}

if (failures) {
  console.error(`docs-site smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  `docs-site smoke: ${pages.length} pages OK, all internal links resolve`
);
