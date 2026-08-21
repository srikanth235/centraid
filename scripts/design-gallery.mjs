#!/usr/bin/env bun
// Product-grammar screenshot gallery (issue #690 §4.2; re-pointed in #799).
//
// WHAT IS PHOTOGRAPHED, AND WHAT EACH LANE CLAIMS
//
//   SH / SH-c  — the REAL BUILT SHELL. The script builds `apps/web`, serves
//                the dist, and drives `#ui-preview`, the in-product component
//                gallery `packages/client/src/react/boot.tsx` mounts. The
//                pixels are the product's own React blocks under the product's
//                own token lowering and the product's own self-hosted faces.
//                SH is the pointer viewport, SH-c the compact one.
//
//   BI / MO    — TOKEN LOWERINGS ONLY, and the baselines must not be read as
//                anything else. `toBlueprintCss()` and `toNativeTheme()` are
//                lowerings, not renderers: an inline blueprint app needs a
//                gateway and a vault to paint, and a React Native surface has
//                no DOM at all. Each lane renders a SHEET of the lowering's
//                own resolved custom properties — every colour as a swatch,
//                every value spelled out in full and never truncated. That
//                fences the real and sufficient claim "this lowering reaches
//                this surface with the values the registry declares", and it
//                depicts nothing the platform does not emit.
//
// Until #799 every lane rendered a hand-written HTML fixture with a
// hand-written stylesheet — a second, invented component vocabulary living
// inside this gate script, photographed as if it were the product. It is gone.
// The BS (served blueprint) lane is gone with it: #799 retired the served app
// plane, so there is no such surface left to photograph.
//
// THE FACES ARE THE PRODUCT'S. The old fixture hardcoded `system-ui`, which
// resolves to a different physical font per OS — the reason this lane was red
// on Linux against darwin-captured baselines (#781). Every lane now loads the
// vendored Instrument Sans `.woff2` files through the same `FONT_FILES`
// manifest `apps/web`'s `centraid-fonts` plugin serves, and every capture
// FAILS LOUDLY if the family does not actually resolve. A screenshot taken
// mid-swap would bake a fallback face into a baseline.
//
// `--update` refreshes the committed baselines; without it the captures are
// compared with a small, deterministic RGBA diff engine.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { chromium } from "playwright";
import { PNG } from "pngjs";

import {
  fonts,
  fontStacks,
  typeForSurface,
} from "../packages/design/src/index.ts";
import { runFidelityLanes } from "./design-gallery-fidelity.mjs";
import { captureLowering } from "./design-gallery-lowering.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE_DIR = path.join(ROOT, "tests/design-gallery/baselines");
const ACTUAL_DIR = path.join(ROOT, "artifacts/design-gallery/actual");
const MANIFEST_FILE = path.join(ROOT, "tests/design-gallery/manifest.json");
const MATRIX_FILE = path.join(ROOT, "tests/design-grammar-matrix.json");
const WEB_DIR = path.join(ROOT, "apps/web");
const WEB_DIST = path.join(WEB_DIR, "dist");
const MATRIX = JSON.parse(readFileSync(MATRIX_FILE, "utf8"));
const UPDATE = process.argv.includes("--update");

/** The one bundled face. Every lane must resolve it or fail. */
const SANS = fonts.sans;

const VIEWPORTS = {
  desktop: { width: 1024, height: 768 },
  compact: { width: 390, height: 844 },
};

// ---------------------------------------------------------------------------
// The built shell, served
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/**
 * `apps/web/vite.config.ts` imports `@centraid/design/font-faces`, which the
 * package export map resolves to `packages/design/dist/font-faces.js`. A
 * fresh CI checkout has no dist; the rest of the shell also imports
 * workspace packages at their `dist` entry (protocol, client, …). Build
 * `@centraid/web`'s package dependencies — not the web app itself — so
 * vite.config can load and the subsequent vite build can resolve them.
 */
function ensureWebShellInputs() {
  execFileSync(
    "bun",
    ["run", "turbo", "run", "build", "--filter=@centraid/web^..."],
    { cwd: ROOT, stdio: "inherit" }
  );
  const fontFaces = path.join(ROOT, "packages/design/dist/font-faces.js");
  if (!existsSync(fontFaces))
    throw new Error(
      "web dependency build produced no packages/design/dist/font-faces.js (required by apps/web vite.config)"
    );
}

/**
 * Rebuild the web dist before every run. The alternative — trusting whatever
 * `apps/web/dist` happens to hold — is how a "verified" baseline ends up
 * photographing a bundle nobody has built since the change under review.
 * `scripts/perf/run-waterfall.mjs` takes the same precaution for the same
 * reason. It costs about five seconds.
 */
function buildWebShell() {
  ensureWebShellInputs();
  execFileSync("bunx", ["vite", "build", "--logLevel", "warn"], {
    cwd: WEB_DIR,
    stdio: "inherit",
  });
  if (!existsSync(path.join(WEB_DIST, "index.html")))
    throw new Error("apps/web build produced no dist/index.html");
}

/** Serve the dist on an ephemeral port. Same-origin, so `/fonts/*` resolves
 *  exactly as it does in production and no CDN enters the picture. */
async function serveDist() {
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0].split("#")[0];
    const rel = url === "/" ? "/index.html" : url;
    const file = path.join(WEB_DIST, path.normalize(rel));
    if (!file.startsWith(WEB_DIST)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.setHeader(
        "Content-Type",
        CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream"
      );
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, server };
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function captures() {
  const entries = [];
  for (const scheme of ["light", "dark"]) {
    entries.push(
      {
        id: `sh-${scheme}`,
        lane: "SH",
        source: "built-shell#ui-preview",
        surface: "SH",
        scheme,
        viewport: VIEWPORTS.desktop,
        matrixMoments: ["M4", "M9", "M17"],
      },
      {
        id: `sh-c-${scheme}`,
        lane: "SH-c",
        source: "built-shell#ui-preview",
        surface: "SH-c",
        scheme,
        viewport: VIEWPORTS.compact,
        matrixMoments: ["M2", "M5", "M13"],
      },
      {
        id: `bi-${scheme}`,
        lane: "BI",
        // Lowering only — see the header. Named so the manifest cannot be
        // misread as component coverage for the inline blueprint surface.
        source: "blueprint-token-lowering",
        surface: "BI",
        scheme,
        viewport: VIEWPORTS.desktop,
        matrixMoments: ["M4", "M9", "M17"],
      },
      {
        id: `mo-advisory-${scheme}`,
        lane: "MO-advisory",
        source: "native-token-lowering",
        surface: "MO",
        scheme,
        viewport: VIEWPORTS.compact,
        matrixMoments: ["M4", "M8", "M17"],
      }
    );
  }
  return entries;
}

function diffPng(expected, actual) {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return { changed: 1, max: 255, reason: "dimensions differ" };
  }
  let changed = 0;
  let max = 0;
  const pixels = expected.width * expected.height;
  for (let index = 0; index < expected.data.length; index += 4) {
    const delta = Math.max(
      Math.abs(expected.data[index] - actual.data[index]),
      Math.abs(expected.data[index + 1] - actual.data[index + 1]),
      Math.abs(expected.data[index + 2] - actual.data[index + 2]),
      Math.abs(expected.data[index + 3] - actual.data[index + 3])
    );
    max = Math.max(max, delta);
    if (delta > 8) changed += 1;
  }
  return { changed: changed / pixels, max, reason: "pixel delta" };
}

function validateGalleryContract(entries) {
  const failures = [];
  // BS is deliberately absent: #799 retired the served blueprint plane, so
  // the surface it named no longer exists to photograph.
  const expectedSurfaces = new Set(["SH", "SH-c", "BI", "MO"]);
  const seen = new Set();
  for (const entry of entries) {
    if (!expectedSurfaces.has(entry.surface))
      failures.push(`${entry.id}: unknown surface ${entry.surface}`);
    if (!MATRIX.surfaces[entry.surface])
      failures.push(
        `${entry.id}: surface is missing from design grammar matrix`
      );
    for (const moment of entry.matrixMoments ?? []) {
      if (!MATRIX.moments[moment])
        failures.push(`${entry.id}: matrix moment ${moment} is missing`);
    }
    seen.add(`${entry.surface}:${entry.scheme}`);
  }
  for (const surface of expectedSurfaces) {
    for (const scheme of ["light", "dark"]) {
      if (!seen.has(`${surface}:${scheme}`))
        failures.push(`missing ${surface}/${scheme} gallery state`);
    }
  }
  // The matrix must not keep describing a surface nothing captures — a
  // renderer listed there with no lane is exactly the stale-doc shape #799
  // is retiring everywhere else.
  for (const surface of Object.keys(MATRIX.surfaces)) {
    if (!expectedSurfaces.has(surface))
      failures.push(
        `design grammar matrix still declares surface ${surface}, which no lane captures`
      );
  }
  return failures;
}

async function assertRenderable(page, selector, id) {
  if ((await page.locator(selector).count()) === 0)
    throw new Error(`${id}: missing renderable ${selector}`);
}

/**
 * The faces are loaded AND actually selected. `document.fonts.ready` alone is
 * not enough — it settles just as happily when every face failed and the
 * renderer fell back to a system font, which is the exact silent failure that
 * made the old `system-ui` baselines OS-dependent.
 */
async function assertProductFaceResolved(page, id) {
  await page.evaluate(() => document.fonts.ready);
  const report = await page.evaluate((family) => {
    const probe = document.createElement("span");
    probe.textContent = "Handgloves 0123456789";
    probe.style.cssText =
      "position:absolute;left:-9999px;top:0;font-size:64px;white-space:pre";
    document.body.appendChild(probe);
    const widthFor = (stack) => {
      probe.style.fontFamily = stack;
      return probe.getBoundingClientRect().width;
    };
    // A family that cannot exist forces the UA's last-resort face. If the
    // product family measures the same, it never loaded and we are looking at
    // a fallback.
    const fallback = widthFor("'centraid-no-such-face', monospace");
    const product = widthFor(`'${family}', 'centraid-no-such-face', monospace`);
    probe.remove();
    return {
      checked: document.fonts.check(`400 13px '${family}'`),
      fallback,
      loaded: [...document.fonts]
        .filter((face) => face.status === "loaded")
        .map((face) => `${face.family} ${face.weight}`),
      product,
    };
  }, SANS);
  if (!report.checked || report.product === report.fallback) {
    throw new Error(
      `${id}: '${SANS}' did not resolve — the capture would bake in a fallback face. ` +
        `check=${report.checked} productWidth=${report.product} fallbackWidth=${report.fallback} ` +
        `loaded=[${report.loaded.join(", ")}]`
    );
  }
}

const LEGAL_TYPE_TRIPLES = new Set(
  [false, true].flatMap((touch) =>
    Object.values(typeForSurface(touch)).map(
      ({ weight, size, lineHeight }) => `${weight}|${size}|${lineHeight}`
    )
  )
);

async function assertLegalTypeTriples(page, root, id) {
  const triples = await page.locator(`${root} *`).evaluateAll((elements) =>
    elements
      .filter((element) => {
        const style = getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          (element.textContent ?? "").trim().length > 0
        );
      })
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          element: element.tagName.toLowerCase(),
          triple: `${style.fontWeight}|${Number(style.fontSize.replace("px", ""))}|${Number(style.lineHeight.replace("px", ""))}`,
        };
      })
  );
  const illegal = [
    ...new Set(
      triples
        .filter(({ triple }) => !LEGAL_TYPE_TRIPLES.has(triple))
        .map(({ element, triple }) => `${element}=${triple}`)
    ),
  ];
  if (illegal.length > 0)
    throw new Error(
      `${id}: illegal computed type triple(s): ${illegal.join(", ")}`
    );
}

/**
 * The control-vocabulary contract, re-expressed against the real shell DOM.
 *
 * The retired fixture asserted "exactly one primary action", which was a
 * property of the fixture's single reference card, not of the product: a
 * COMPONENT GALLERY shows every variant by construction, and a disabled
 * primary beside an enabled one is one of the things it exists to show. What
 * actually transfers is the M4 invariant underneath it — ONE ACCENT FILL — so
 * that is what is checked here, and it is a stronger claim than a count: no
 * variant other than `primary` may paint the accent fill.
 */
async function assertControlVocabulary(page, root, id) {
  await Promise.all(
    ["primary", "secondary", "quiet", "destructive"].map((variant) =>
      assertRenderable(page, `${root} [data-variant="${variant}"]`, id)
    )
  );

  const fills = await page
    .locator(`${root} [data-variant]`)
    .evaluateAll((elements) =>
      elements.map((element) => ({
        background: getComputedStyle(element).backgroundColor,
        disabled:
          element.disabled === true ||
          element.getAttribute("aria-disabled") === "true",
        variant: element.dataset.variant,
      }))
    );
  const primaryFills = new Set(
    fills
      .filter((f) => f.variant === "primary" && !f.disabled)
      .map((f) => f.background)
  );
  if (primaryFills.size !== 1)
    throw new Error(
      `${id}: expected one accent fill for the primary variant, saw ${[...primaryFills].join(" / ") || "none"}`
    );
  const [accent] = primaryFills;
  const trespassers = fills.filter(
    (f) => f.variant !== "primary" && f.background === accent
  );
  if (trespassers.length > 0)
    throw new Error(
      `${id}: the accent fill is not the primary variant's alone — ${trespassers
        .map((f) => f.variant)
        .join(", ")} paint ${accent}`
    );

  const primary = page.locator(
    `${root} [data-variant="primary"]:not([disabled]):not([aria-disabled="true"])`
  );
  await primary.first().focus();
  const focused = await page.evaluate(
    () => document.activeElement?.dataset.variant
  );
  if (focused !== "primary")
    throw new Error(`${id}: the primary action is not keyboard focusable`);
}

/** The block vocabulary is actually on screen, named as the product names it. */
const GALLERY_BLOCK_LABELS = [
  "Records",
  "Filters",
  "Window",
  "Runs per day over the last 7 days",
];

const FREEZE_MOTION =
  "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

/** Where `boot.tsx` mounts the in-product component gallery. */
const PREVIEW_HOST = "#react-preview-root";

async function captureShell(page, origin, entry) {
  await page.goto(`${origin}/#ui-preview`, { waitUntil: "load" });
  const host = PREVIEW_HOST;
  await page.locator(`${host} > *`).waitFor();
  // The scheme is the product's own attribute, set the way the renderer sets
  // it once it has read the member's preference.
  await page.evaluate((scheme) => {
    document.documentElement.dataset.theme = scheme;
  }, entry.scheme);
  await assertProductFaceResolved(page, entry.id);
  await assertRenderable(page, `${host} > *`, entry.id);
  await Promise.all(
    GALLERY_BLOCK_LABELS.map((label) =>
      assertRenderable(page, `${host} [aria-label="${label}"]`, entry.id)
    )
  );
  await assertControlVocabulary(page, host, entry.id);
  await assertLegalTypeTriples(page, host, entry.id);
  await page.addStyleTag({ content: FREEZE_MOTION });
  // The preview host is a fixed, scrolling overlay, and a browser paints only
  // the visible part of one — an element screenshot of it comes back with
  // everything below the fold blank. Unpin it so the DOCUMENT scrolls and a
  // full-page capture is complete. This moves the host wrapper only: no
  // product component's box, type or colour changes, and the `padding-top`
  // that drops away is the macOS traffic-light inset, which is host chrome
  // rather than design.
  await page.addStyleTag({
    content:
      `${host} { position: static !important; inset: auto !important; overflow: visible !important; padding-top: 0 !important; z-index: auto !important; } ` +
      // The shell pins `html`/`body` to the viewport and hides their overflow
      // — an app window does not scroll, its panes do. Let the document grow
      // instead, or the capture is silently clipped at one viewport.
      "html, body { height: auto !important; min-height: 0 !important; overflow: visible !important; background: var(--bg); margin: 0; }",
  });
  // One frame for the relayout before the shutter.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => resolve(null));
      })
  );
  return null;
}

async function main() {
  const entries = captures();
  const manifest = {
    issue: 690,
    reviewIssue: 695,
    generatedBy: "scripts/design-gallery.mjs",
    // Read by a human looking at the PNGs, so the narrower lanes cannot be
    // mistaken for component coverage they do not have.
    laneClaims: {
      BI: "token lowering only — toBlueprintCss() resolved values, not a rendered inline app",
      MO: "token lowering only — toNativeTheme() resolved values; React Native has no DOM to photograph",
      SH: "the built shell's #ui-preview component gallery, pointer viewport",
      "SH-c":
        "the built shell's #ui-preview component gallery, compact viewport",
    },
    // Read from the SAME surface the SH lane photographs, with the document
    // direction flipped and the copy replaced by CJK. They take no baseline:
    // what the rulebook binds under RTL and CJK is a set of invariants, not an
    // appearance, so they are asserted as values rather than compared as
    // pixels. See scripts/design-gallery-fidelity.mjs.
    fidelityLanes: {
      cjk: "the SH surface under Japanese copy — the one face's mandatory CJK fallbacks reach every rendered stack, and no role's rung moves with the glyphs",
      rtl: "the SH surface under dir=rtl — every asymmetric box mirrors, no physical text alignment survives the flip, and the numeric register keeps its pinned direction and its bidi isolate",
    },
    entries,
  };
  const failures = validateGalleryContract(entries);
  await mkdir(BASELINE_DIR, { recursive: true });
  await mkdir(ACTUAL_DIR, { recursive: true });
  if (UPDATE) {
    await writeFile(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    try {
      const checkedIn = JSON.parse(await readFile(MANIFEST_FILE, "utf8"));
      if (JSON.stringify(checkedIn) !== JSON.stringify(manifest))
        failures.push("manifest is stale; run design:gallery -- --update");
    } catch {
      failures.push(
        "manifest is missing or invalid; run design:gallery -- --update"
      );
    }
  }

  buildWebShell();
  const { origin, server } = await serveDist();
  const browser = await chromium.launch({ headless: true });
  try {
    await entries.reduce(
      (chain, entry) =>
        chain.then(async () => {
          const page = await browser.newPage({
            colorScheme: entry.scheme,
            deviceScaleFactor: 1,
            viewport: entry.viewport,
          });
          await page.emulateMedia({ reducedMotion: "reduce" });
          if (entry.surface === "SH" || entry.surface === "SH-c")
            await captureShell(page, origin, entry);
          else
            await captureLowering(page, origin, entry, {
              freezeMotion: FREEZE_MOTION,
              legalTypeTriples: assertLegalTypeTriples,
              productFaceResolved: assertProductFaceResolved,
              renderable: assertRenderable,
            });
          const actualFile = path.join(ACTUAL_DIR, `${entry.id}.png`);
          const baselineFile = path.join(BASELINE_DIR, `${entry.id}.png`);
          await page.screenshot({ fullPage: true, path: actualFile });
          await page.close();
          if (UPDATE) {
            await writeFile(baselineFile, await readFile(actualFile));
            return;
          }
          let expected;
          try {
            expected = PNG.sync.read(await readFile(baselineFile));
          } catch {
            failures.push(`${entry.id}: missing baseline (run with --update)`);
            return;
          }
          const actual = PNG.sync.read(await readFile(actualFile));
          const result = diffPng(expected, actual);
          console.log(
            `${entry.id}: ${(result.changed * 100).toFixed(2)}% changed, max channel delta ${result.max}`
          );
          if (result.changed > 0.01) {
            failures.push(
              `${entry.id}: ${(result.changed * 100).toFixed(2)}% changed, max channel delta ${result.max}`
            );
          }
        }),
      Promise.resolve()
    );
    // After the captures, never instead of them: a fidelity finding is a
    // statement about the surface, and it must not stop a baseline being
    // written or compared. One more page on an already-warm browser and an
    // already-built dist, which is why this rides inside `design:gallery`
    // rather than standing up a second gate with its own vite build.
    const fidelityPage = await browser.newPage({
      colorScheme: "light",
      deviceScaleFactor: 1,
      viewport: VIEWPORTS.desktop,
    });
    await fidelityPage.emulateMedia({ reducedMotion: "reduce" });
    try {
      failures.push(
        ...(await runFidelityLanes(fidelityPage, origin, {
          freezeMotion: FREEZE_MOTION,
          host: PREVIEW_HOST,
          legalTypeTriples: assertLegalTypeTriples,
          productFaceResolved: assertProductFaceResolved,
          sansStack: fontStacks.sans,
        }))
      );
    } finally {
      await fidelityPage.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `${UPDATE ? "Updated" : "Verified"} ${entries.length} product-grammar baselines.`
    );
  }
}

await main();
