import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { apps, toBlueprintCss } from "@centraid/design";

// Home tile under a mirrored writing direction (#842).
// `lint:logical-insets` cannot prove a logical replacement resolves as intended.
// DEMONSTRATED RED: restore `right: -3px` / `text-align: left` in
// AppCard.module.css and the RTL half fails while LTR stays green.

const here = import.meta.dirname;
const REPO_ROOT = path.resolve(here, "../../../..");
const APP_CARD = path.join(
  REPO_ROOT,
  "packages/client/src/react/ui/AppCard.tsx"
);
const EVIDENCE_DIR = path.join(REPO_ROOT, "artifacts/e2e/ui-impact");
const EVIDENCE_PNG = "issue-842-logical-insets-appcard.png";

function appNamed(id: string): string {
  const found = apps.find((app) => app.id === id);
  if (!found) throw new Error(`no builtin app ${id}`);
  return found.name;
}

const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import AppCard from ${JSON.stringify(APP_CARD)};
import { apps } from "@centraid/design";

const CARDS = [
  { id: "notes", tone: "new", stamp: "2h ago" },
  { id: "people", tone: "draft", stamp: "saved" },
  { id: "photos", tone: null, stamp: "yesterday" },
];

const pane = (dir) =>
  createElement(
    "div",
    { className: "pane", dir, "data-dir": dir },
    createElement(
      "div",
      { className: "grid" },
      CARDS.map((card) =>
        createElement(AppCard, {
          app: apps.find((a) => a.id === card.id),
          key: card.id,
          stamp: card.stamp,
          tone: card.tone,
        })
      )
    )
  );

createRoot(document.getElementById("root")).render(
  createElement("div", { className: "seat" }, pane("ltr"), pane("rtl"))
);
`;

async function bundleCard(): Promise<{ js: string; css: string }> {
  const result = await build({
    stdin: {
      contents: ENTRY,
      loader: "tsx",
      resolveDir: here,
      sourcefile: "app-card-logical-insets-harness.tsx",
    },
    bundle: true,
    define: { "process.env.NODE_ENV": '"production"' },
    format: "iife",
    jsx: "automatic",
    // Never written (`write: false`); esbuild still needs a path to name CSS-module output.
    outdir: path.join(here, ".app-card-logical-insets-bundle"),
    platform: "browser",
    target: "es2022",
    write: false,
  });
  return {
    css:
      result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "",
    js:
      result.outputFiles.find((file) => file.path.endsWith(".js"))?.text ?? "",
  };
}

const HARNESS_CSS = `
  body { margin: 0; background: var(--bg); color: var(--text); }
  .seat { display: flex; flex-direction: column; gap: 24px; padding: 24px; }
  .pane { padding: 16px; border: 1px solid var(--line); border-radius: 12px; }
  .grid { display: flex; flex-wrap: wrap; gap: 12px; }
`;

test("the home tile mirrors with the writing direction, not against it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { css, js } = await bundleCard();
  await page.setViewportSize({ height: 900, width: 1180 });
  await page.setContent(
    `<style>${toBlueprintCss()}</style><style>${css}</style>` +
      `<style>${HARNESS_CSS}</style>` +
      `<body><div id="root"></div></body>`
  );
  await page.addScriptTag({ content: js });

  const ltr = page.locator('[data-dir="ltr"]');
  const rtl = page.locator('[data-dir="rtl"]');
  await expect(ltr.getByTestId("app-tile")).toHaveCount(3);
  await expect(rtl.getByTestId("app-tile")).toHaveCount(3);

  // Dot rides INLINE-END. Signed offset from plate centre.
  const dotSide = async (pane: typeof ltr): Promise<number> => {
    const tile = pane.getByTestId("app-tile").first();
    return tile.evaluate((el) => {
      const dot = el.querySelector<HTMLElement>("span[data-tone]");
      const plate = dot?.parentElement;
      if (!dot || !plate) throw new Error("no status dot on the first tile");
      const d = dot.getBoundingClientRect();
      const p = plate.getBoundingClientRect();
      return d.left + d.width / 2 - (p.left + p.width / 2);
    });
  };
  // LTR: inline-end is RIGHT — positive. RTL: LEFT. Old `right: -3px` stayed positive.
  expect(await dotSide(ltr)).toBeGreaterThan(0);
  expect(await dotSide(rtl)).toBeLessThan(0);

  // Computed `text-align` so a physical `left` fails even though LTR looks identical.
  const align = async (pane: typeof ltr): Promise<string> =>
    pane
      .getByTestId("app-tile")
      .first()
      .evaluate((el) => getComputedStyle(el).textAlign);
  expect(await align(ltr)).toBe("start");
  expect(await align(rtl)).toBe("start");

  const nameEdge = async (pane: typeof ltr): Promise<number> => {
    const tile = pane.getByTestId("app-tile").first();
    return tile.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return (
        (el.querySelector("div")?.getBoundingClientRect().left ?? 0) - box.left
      );
    });
  };
  expect(await nameEdge(ltr)).toBeLessThanOrEqual((await nameEdge(rtl)) + 0.5);

  await expect(ltr.getByTestId("app-tile").first()).toContainText(
    appNamed("notes")
  );

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    fullPage: true,
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
  });
});
