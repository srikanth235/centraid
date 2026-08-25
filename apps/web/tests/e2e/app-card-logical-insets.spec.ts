import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { apps, toBlueprintCss } from "@centraid/design";

// THE HOME TILE UNDER A MIRRORED WRITING DIRECTION (#842).
//
// `AppCard.module.css` names logical sides, never physical ones —
// `text-align: start`, and `inset-inline-end: -3px` for the status dot. Under
// LTR a physical side is indistinguishable from its logical twin, which is
// exactly what makes the choice dangerous to review: every screenshot, jsdom
// assertion and class-name check stays green either way. The difference is
// only observable when the inline axis flips.
//
// `lint:logical-insets` proves the SOURCE names no physical side. It
// cannot prove the replacement resolves the way the author intended — a
// `inset-inline-start` typo passes that linter and silently parks the dot on
// the wrong corner in Arabic and Hebrew. Only a real browser resolving a real
// `dir="rtl"` settles it, which is why this lives here and not in a unit test.
//
// DEMONSTRATED RED: restore `right: -3px` / `text-align: left` in
// AppCard.module.css and the RTL half below fails while the LTR half stays
// green — the precise blind spot this spec closes.
//
// The harness mounts the SHIPPED `AppCard` with the SHIPPED design tokens and
// reimplements nothing; it needs no gateway and no vault, because a tile is a
// pure function of its app metadata. Same shape `app-navigation-rail.spec.ts`
// uses for the rail.
//
// The capture is the UI-impact evidence (#842).

const here = import.meta.dirname;
const REPO_ROOT = path.resolve(here, "../../../..");
const APP_CARD = path.join(
  REPO_ROOT,
  "packages/client/src/react/ui/AppCard.tsx"
);
const EVIDENCE_DIR = path.join(REPO_ROOT, "artifacts/e2e/ui-impact");
const EVIDENCE_PNG = "issue-842-logical-insets-appcard.png";

/** The shipped metadata for one builtin, by id. */
function appNamed(id: string): string {
  const found = apps.find((app) => app.id === id);
  if (!found) throw new Error(`no builtin app ${id}`);
  return found.name;
}

/** Both panes are built from the same three tiles, so any left/right
 *  difference between them is the writing direction and nothing else. */
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

/** Bundle the shipped tile, its CSS module included, for the browser. */
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
    // Never written (`write: false`), but esbuild needs a path to name the
    // CSS-module output against — the class map and the stylesheet are two
    // halves of one build.
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

  // The dot rides the icon plate's INLINE-END corner. Measured as a signed
  // offset from the plate's own centre so the claim is about which side it sat
  // on, not about a pixel budget.
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
  // LTR: inline-end is the RIGHT edge — a positive offset from centre.
  expect(await dotSide(ltr)).toBeGreaterThan(0);
  // RTL: inline-end is the LEFT edge. With the old physical `right: -3px` this
  // stayed positive and the dot collided with the name column.
  expect(await dotSide(rtl)).toBeLessThan(0);

  // `text-align: start` resolves against the same axis. The computed value is
  // read rather than asserted as a literal, so this fails on a physical
  // `left` even though both spellings render identically under LTR.
  const align = async (pane: typeof ltr): Promise<string> =>
    pane
      .getByTestId("app-tile")
      .first()
      .evaluate((el) => getComputedStyle(el).textAlign);
  expect(await align(ltr)).toBe("start");
  expect(await align(rtl)).toBe("start");

  // ...and that logical value really does flip the painted side, so "start"
  // is not merely an inherited default that happens to match.
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

  // The shipped metadata is what was photographed — not a fixture that could
  // drift away from the tiles the member actually sees.
  await expect(ltr.getByTestId("app-tile").first()).toContainText(
    appNamed("notes")
  );

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    fullPage: true,
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
  });
});
