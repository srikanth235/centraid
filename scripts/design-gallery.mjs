#!/usr/bin/env bun
import { readFileSync } from "node:fs";
// Product-grammar screenshot gallery (issue #690, §4.2).
//
// `--update` refreshes the committed baselines. Without it the same captures
// are compared with a small, deterministic RGBA diff engine. Served blueprint
// captures use the real visual harness; BI/SH-c/MO advisory captures use the
// same generated lowerings in a compact contract fixture so the lanes exist
// without pretending a native simulator is a PR dependency.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";
import { PNG } from "pngjs";

import {
  typeForSurface,
  toBlueprintCss,
  toCss,
  toNativeTheme,
} from "../packages/design/src/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE_DIR = path.join(ROOT, "tests/design-gallery/baselines");
const ACTUAL_DIR = path.join(ROOT, "artifacts/design-gallery/actual");
const MANIFEST_FILE = path.join(ROOT, "tests/design-gallery/manifest.json");
const MATRIX_FILE = path.join(ROOT, "tests/design-grammar-matrix.json");
const KIT_CSS = readFileSync(
  path.join(ROOT, "packages/design/kit/kit.css"),
  "utf8"
);
const MATRIX = JSON.parse(readFileSync(MATRIX_FILE, "utf8"));
const UPDATE = process.argv.includes("--update");

const BLUEPRINT_APPS = [
  "agenda",
  "docs",
  "locker",
  "notes",
  "people",
  "photos",
  "tally",
  "tasks",
];
const VIEWPORTS = {
  desktop: { width: 1024, height: 768 },
  compact: { width: 390, height: 844 },
};

const APP_METADATA = Object.fromEntries(
  BLUEPRINT_APPS.map((app) => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(ROOT, "packages/blueprints/apps", app, "app.json"),
        "utf8"
      )
    );
    return [app, manifest];
  })
);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function nativeTokenCss(scheme) {
  const theme = toNativeTheme(scheme);
  const vars = [];
  for (const [key, value] of Object.entries(theme.colors)) {
    const name = key.replace(
      /(?<letter>[A-Z])/gu,
      (_match, letter) => `-${letter.toLowerCase()}`
    );
    vars.push(`--${name}: ${value};`);
  }
  for (const [key, value] of Object.entries(theme.radii))
    vars.push(`--r-${key}: ${value}px;`);
  for (const [key, value] of Object.entries(theme.spacing))
    vars.push(`--sp-${key}: ${value}px;`);
  for (const [key, value] of Object.entries(theme.type))
    vars.push(
      `--t-${key.replace(/(?<letter>[A-Z])/gu, (_match, letter) => `-${letter.toLowerCase()}`)}: ${value.weight} ${value.fontSize}px/${value.lineHeight}px system-ui;`
    );
  vars.push(
    `--target-min: ${theme.targetMin.coarse}px;`,
    `--dur-1: ${theme.durations.one}ms;`,
    `--dur-2: ${theme.durations.two}ms;`,
    "--ease: cubic-bezier(0.2, 0.7, 0.3, 1);",
    "--font-sans: system-ui, sans-serif;",
    "--font-code: ui-monospace, monospace;"
  );
  return `:root { ${vars.join(" ")} }`;
}

function fixtureHtml({ surface, scheme, width, app }) {
  const tokens =
    surface === "BI" || surface === "BS"
      ? toBlueprintCss()
      : surface === "MO"
        ? nativeTokenCss(scheme)
        : toCss();
  const manifest = app ? APP_METADATA[app] : undefined;
  const appName = manifest?.name ?? "Centraid";
  const appDescription = manifest?.description ?? "Shared host reference state";
  const appIcon = manifest?.iconKey ?? "Grid";
  // An identity hue belongs to an app. The host itself — the "Centraid" mark
  // these hostless fixtures render — takes no hue under the Binding Layer; it
  // is ink, like Home in the launcher. Falling back to a product hue here made
  // every hostless baseline claim a colour the shell never shows (#707).
  const appIdentity = manifest
    ? `var(--c-${manifest.colorKey})`
    : "var(--text)";
  return `<!doctype html>
<html data-theme="${scheme}">
<head><meta charset="utf-8"><style>${tokens}${KIT_CSS}
  :root[data-theme="dark"] { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-width: 0; background: var(--bg); color: var(--text); font: var(--t-body); }
  .gallery { min-height: 100vh; padding: 24px; display: grid; align-content: start; gap: 16px; max-width: 760px; margin: 0 auto; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .eyebrow { color: var(--text-faint); font: var(--t-eyebrow); text-transform: uppercase; letter-spacing: .08em; }
  h1 { margin: 4px 0 0; font: var(--t-title); }
  .identity { display: inline-flex; align-items: center; gap: 8px; color: var(--text-soft); font: var(--t-small); }
  .mark { width: 28px; height: 28px; border-radius: var(--r-md); background: ${appIdentity}; }
  .kit-panel { padding: 18px; box-shadow: var(--shadow-sm); display: grid; gap: 12px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: var(--target-min); }
  .meta { color: var(--text-soft); font: var(--t-small); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .notice { border-left: 3px solid var(--accent); background: var(--accent-soft); padding: 10px 12px; color: var(--text-soft); font: var(--t-small); }
  strong { font: var(--t-body-strong); }
  @media (max-width: 719px) { .gallery { padding: 16px; } .actions button { flex: 1; } }
</style></head>
<body><main class="gallery" data-gallery-surface="${surface}" data-gallery-scheme="${scheme}" data-gallery-width="${width}">
  <header class="top"><div><div class="eyebrow">${escapeHtml(surface)} reference${app ? ` · ${escapeHtml(app)}` : ""}</div><h1>${escapeHtml(appName)}</h1></div><div class="identity"><span class="mark"></span><span>Centraid</span></div></header>
  <section class="kit-panel" data-role="reference-state" aria-label="Reference state"><div class="row"><div><strong>${escapeHtml(appName)} ready to act</strong><div class="meta">${escapeHtml(appDescription.slice(0, 96))}</div></div><span aria-label="Selected" class="mark"></span></div><div class="notice">News is a notice. Decisions belong in a dialog.</div><div class="actions"><button class="kit-btn primary" data-variant="primary">Create note</button><button class="kit-btn quiet" data-variant="quiet">Ask your vault</button><button class="kit-btn secondary" data-variant="secondary">Close</button></div><div class="meta" data-icon-key="${escapeHtml(appIcon)}">Manifest icon: ${escapeHtml(appIcon)}</div></section>
</main></body></html>`;
}

function captures() {
  const entries = [];
  for (const scheme of ["light", "dark"]) {
    for (const app of BLUEPRINT_APPS) {
      entries.push({
        id: `bs-${app}-${scheme}`,
        lane: "BS",
        source: "blueprint-manifest+kit-runtime",
        surface: "BS",
        app,
        scheme,
        viewport: VIEWPORTS.desktop,
        matrixMoments: ["M4", "M7", "M10"],
      });
    }
    entries.push(
      {
        id: `bi-${scheme}`,
        lane: "BI",
        source: "blueprint-contract+kit-runtime",
        surface: "BI",
        scheme,
        viewport: VIEWPORTS.desktop,
        matrixMoments: ["M4", "M9", "M17"],
      },
      {
        id: `sh-c-${scheme}`,
        lane: "SH-c",
        source: "shell-contract+kit-runtime",
        surface: "SH-c",
        scheme,
        viewport: VIEWPORTS.compact,
        matrixMoments: ["M2", "M5", "M13"],
      },
      {
        id: `mo-advisory-${scheme}`,
        lane: "MO-advisory",
        source: "native-contract+kit-runtime",
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
  const expectedSurfaces = new Set(["BI", "BS", "SH-c", "MO"]);
  const seen = new Set();
  for (const entry of entries) {
    if (!expectedSurfaces.has(entry.surface))
      failures.push(`${entry.id}: unknown surface ${entry.surface}`);
    if (!MATRIX.surfaces[entry.surface === "MO" ? "MO" : entry.surface])
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
  return failures;
}

async function assertRenderable(page, selector, id) {
  if ((await page.locator(selector).count()) === 0)
    throw new Error(`${id}: missing renderable ${selector}`);
}

const LEGAL_TYPE_TRIPLES = new Set(
  [false, true].flatMap((touch) =>
    Object.values(typeForSurface(touch)).map(
      ({ weight, size, lineHeight }) => `${weight}|${size}|${lineHeight}`
    )
  )
);

async function assertLegalTypeTriples(page, id) {
  const triples = await page.locator("body *").evaluateAll((elements) =>
    elements
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          element: element.tagName.toLowerCase(),
          triple: `${style.fontWeight}|${Number(style.fontSize.replace("px", ""))}|${Number(style.lineHeight.replace("px", ""))}`,
        };
      })
  );
  const illegal = triples.filter(
    ({ triple }) => !LEGAL_TYPE_TRIPLES.has(triple)
  );
  if (illegal.length > 0)
    throw new Error(
      `${id}: illegal computed type triple(s): ${illegal
        .map(({ element, triple }) => `${element}=${triple}`)
        .join(", ")}`
    );
}

async function main() {
  const entries = captures();
  const manifest = {
    issue: 690,
    reviewIssue: 695,
    generatedBy: "scripts/design-gallery.mjs",
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
  const browser = await chromium.launch({ headless: true });
  try {
    await entries.reduce(
      (chain, entry) =>
        chain.then(async () => {
          const page = await browser.newPage({
            viewport: entry.viewport,
            deviceScaleFactor: 1,
          });
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.setContent(
            fixtureHtml({
              surface: entry.surface,
              scheme: entry.scheme,
              width: entry.viewport.width,
              app: entry.app,
            }),
            { waitUntil: "load" }
          );
          await page.locator("main[data-gallery-surface]").waitFor();
          await page.evaluate(() => document.fonts?.ready);
          await assertRenderable(page, "main[data-gallery-surface]", entry.id);
          await assertRenderable(
            page,
            '[data-role="reference-state"]',
            entry.id
          );
          await assertRenderable(page, '[data-variant="primary"]', entry.id);
          await assertRenderable(page, '[data-variant="secondary"]', entry.id);
          await assertLegalTypeTriples(page, entry.id);
          const primaryCount = await page
            .locator('[data-variant="primary"]')
            .count();
          if (primaryCount !== 1)
            throw new Error(
              `${entry.id}: expected one primary action, found ${primaryCount}`
            );
          await page.locator('[data-variant="primary"]').focus();
          if (
            (await page.evaluate(
              () => document.activeElement?.dataset.variant
            )) !== "primary"
          )
            throw new Error(
              `${entry.id}: primary action is not keyboard focusable`
            );
          await page.addStyleTag({
            content:
              "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
          });
          const actualFile = path.join(ACTUAL_DIR, `${entry.id}.png`);
          const baselineFile = path.join(BASELINE_DIR, `${entry.id}.png`);
          await page.screenshot({ path: actualFile, fullPage: true });
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
          if (result.changed > 0.01) {
            failures.push(
              `${entry.id}: ${(result.changed * 100).toFixed(2)}% changed, max channel delta ${result.max}`
            );
          }
        }),
      Promise.resolve()
    );
  } finally {
    await browser.close();
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
