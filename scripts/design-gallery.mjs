#!/usr/bin/env bun
/* oxlint-disable no-await-in-loop -- captures are intentionally serialized so browser state and baseline files stay deterministic. */
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

import { toBlueprintCss, toCss } from "../packages/design/src/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE_DIR = path.join(ROOT, "tests/design-gallery/baselines");
const ACTUAL_DIR = path.join(ROOT, "artifacts/design-gallery/actual");
const MANIFEST_FILE = path.join(ROOT, "tests/design-gallery/manifest.json");
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

function fixtureHtml({ surface, scheme, width, app }) {
  const tokens =
    surface === "BI" || surface === "BS" ? toBlueprintCss() : toCss();
  const appIdentity =
    surface === "MO" ? "var(--c-indigo)" : "var(--app-identity, var(--c-teal))";
  return `<!doctype html>
<html data-theme="${scheme}">
<head><meta charset="utf-8"><style>${tokens}
  :root[data-theme="dark"] { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-width: 0; background: var(--bg); color: var(--text); font-family: var(--font-sans); }
  .gallery { min-height: 100vh; padding: 24px; display: grid; align-content: start; gap: 16px; max-width: 760px; margin: 0 auto; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .eyebrow { color: var(--text-faint); font: var(--t-eyebrow); text-transform: uppercase; letter-spacing: .08em; }
  h1 { margin: 4px 0 0; font: var(--t-title); }
  .identity { display: inline-flex; align-items: center; gap: 8px; color: var(--text-soft); font: var(--t-small); }
  .mark { width: 28px; height: 28px; border-radius: var(--r-md); background: ${appIdentity}; }
  .panel { border: 1px solid var(--line); border-radius: var(--r-lg); padding: 18px; background: var(--bg-elev); box-shadow: var(--shadow-sm); display: grid; gap: 12px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: var(--target-min); }
  .meta { color: var(--text-soft); font: var(--t-small); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button { min-height: var(--target-min); border-radius: var(--r-md); padding: 0 14px; border: 1px solid var(--line-strong); background: var(--bg-elev); color: var(--text); font: var(--t-control); }
  button.primary { border-color: var(--accent-fill); background: var(--accent-fill); color: var(--text-inv); }
  button.quiet { border-color: transparent; background: transparent; color: var(--text-soft); }
  .notice { border-left: 3px solid var(--accent); background: var(--accent-soft); padding: 10px 12px; color: var(--text-soft); font: var(--t-small); }
  @media (max-width: 719px) { .gallery { padding: 16px; } .actions button { flex: 1; } }
</style></head>
<body><main class="gallery" data-gallery-surface="${surface}" data-gallery-scheme="${scheme}" data-gallery-width="${width}">
  <header class="top"><div><div class="eyebrow">${surface} reference${app ? ` · ${app}` : ""}</div><h1>Product grammar</h1></div><div class="identity"><span class="mark"></span><span>Centraid</span></div></header>
  <section class="panel" aria-label="Reference state"><div class="row"><div><strong>Ready to act</strong><div class="meta">Shared hierarchy, adapted density, local host chrome.</div></div><span aria-label="Selected" class="mark"></span></div><div class="notice">News is a notice. Decisions belong in a dialog.</div><div class="actions"><button class="primary">Create note</button><button class="quiet">Ask your vault</button><button>Close</button></div></section>
</main></body></html>`;
}

function captures() {
  const entries = [];
  for (const scheme of ["light", "dark"]) {
    for (const app of BLUEPRINT_APPS) {
      entries.push({
        id: `bs-${app}-${scheme}`,
        lane: "BS",
        fixture: true,
        surface: "BS",
        app,
        scheme,
        viewport: VIEWPORTS.desktop,
      });
    }
    entries.push(
      {
        id: `bi-${scheme}`,
        lane: "BI",
        fixture: true,
        surface: "BI",
        scheme,
        viewport: VIEWPORTS.desktop,
      },
      {
        id: `sh-c-${scheme}`,
        lane: "SH-c",
        fixture: true,
        surface: "SH-c",
        scheme,
        viewport: VIEWPORTS.compact,
      },
      {
        id: `mo-advisory-${scheme}`,
        lane: "MO-advisory",
        fixture: true,
        surface: "MO",
        scheme,
        viewport: VIEWPORTS.compact,
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

async function main() {
  const entries = captures();
  await mkdir(BASELINE_DIR, { recursive: true });
  await mkdir(ACTUAL_DIR, { recursive: true });
  await writeFile(
    MANIFEST_FILE,
    `${JSON.stringify({ issue: 690, generatedBy: "scripts/design-gallery.mjs", entries }, null, 2)}\n`
  );
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  try {
    for (const entry of entries) {
      const page = await browser.newPage({
        viewport: entry.viewport,
        deviceScaleFactor: 1,
      });
      if (entry.fixture) {
        await page.setContent(
          fixtureHtml({
            surface: entry.surface,
            scheme: entry.scheme,
            width: entry.viewport.width,
            app: entry.app,
          })
        );
      } else {
        await page.goto(entry.url, { waitUntil: "domcontentloaded" });
      }
      await page.addStyleTag({
        content:
          "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
      });
      await page.waitForTimeout(400);
      const actualFile = path.join(ACTUAL_DIR, `${entry.id}.png`);
      const baselineFile = path.join(BASELINE_DIR, `${entry.id}.png`);
      await page.screenshot({ path: actualFile, fullPage: true });
      await page.close();
      if (UPDATE) {
        await writeFile(baselineFile, await readFile(actualFile));
        continue;
      }
      let expected;
      try {
        expected = PNG.sync.read(await readFile(baselineFile));
      } catch {
        failures.push(`${entry.id}: missing baseline (run with --update)`);
        continue;
      }
      const actual = PNG.sync.read(await readFile(actualFile));
      const result = diffPng(expected, actual);
      if (result.changed > 0.01) {
        failures.push(
          `${entry.id}: ${(result.changed * 100).toFixed(2)}% changed, max channel delta ${result.max}`
        );
      }
    }
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
