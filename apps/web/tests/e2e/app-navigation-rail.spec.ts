import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { metrics, toBlueprintCss } from "@centraid/design";

// THE APP NAVIGATION RAIL, in a real browser (#835). Four handoff
// definition-of-done items are LAYOUT/FOCUS claims jsdom cannot settle:
// 1090 rail-width hold + grid reflow, independent rail/content scrolling,
// one tab stop into the rail, the `(pointer: fine)` row rung. Mounts the
// SHIPPED NavRail and row tables — nothing reimplemented. This capture is
// the #835 UI-impact evidence.

const here = import.meta.dirname;
const REPO_ROOT = path.resolve(here, "../../../..");
const NAV_RAIL = path.join(
  REPO_ROOT,
  "packages/blueprints/apps/_shared/NavRail.tsx"
);
const PHOTOS_RAIL = path.join(
  REPO_ROOT,
  "packages/blueprints/apps/photos/nav-rail.ts"
);
const DOCS_RAIL = path.join(
  REPO_ROOT,
  "packages/blueprints/apps/docs/nav-rail.ts"
);
const EVIDENCE_DIR = path.join(REPO_ROOT, "artifacts/e2e/ui-impact");
const EVIDENCE_PNG = "issue-835-app-navigation-rail.png";

/** A tile is 104px + a 12px gap, so how many fit is a readable proxy for
 *  "the grid reflows" without depending on Photos' own justification pass. */
const TILE = 104;

const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { NavRail } from ${JSON.stringify(NAV_RAIL)};
import { photosNavRail } from ${JSON.stringify(PHOTOS_RAIL)};
import { docsNavRail } from ${JSON.stringify(DOCS_RAIL)};

window.__routed = [];
const route = (label) => window.__routed.push(String(label));

const photosCounts = new Map([
  ["library", 6214],
  ["built-in:favorites", 128],
  ["built-in:albums", 14],
  ["built-in:places", 42],
  ["built-in:people", 12],
  ["built-in:duplicates", 6],
  ["built-in:trash", 24],
]);
const docsCounts = new Map([
  ["list", 1908],
  ["built-in:recent", 8],
  ["built-in:starred", 18],
  ["built-in:folders", 4],
  ["built-in:trash", 9],
]);
const folders = [
  { folder_id: "f-property", name: "Property", parent_id: null },
  { folder_id: "f-money", name: "Money", parent_id: null },
  { folder_id: "f-identity", name: "Identity", parent_id: null },
  { folder_id: "f-move", name: "The move", parent_id: null },
];
// Enough rows for the counts to be real and for the tree to have a shape.
const activeDocs = [];
const fill = (folderId, n) => {
  for (let i = 0; i < n; i += 1)
    activeDocs.push({ document_id: folderId + "-" + i, folder_id: folderId });
};
fill("f-property", 38);
fill("f-money", 104);
fill("f-identity", 12);
fill("f-move", 26);
fill(null, 17);

const tiles = Array.from({ length: 60 }, (_, i) =>
  createElement("div", { key: i, className: "tile" })
);

function Pane({ id, label, items }) {
  return createElement(
    "div",
    { className: "pane", id },
    createElement(NavRail, { label, items }),
    createElement(
      "div",
      { className: "scroller", "data-scroller": label },
      createElement("div", { className: "grid" }, tiles)
    )
  );
}

createRoot(document.getElementById("root")).render(
  createElement(
    "div",
    { className: "seat" },
    createElement("button", { type: "button", id: "before" }, "before"),
    createElement(Pane, {
      id: "photos",
      label: "Photos",
      // Standing inside an album: **Albums** is the current row.
      items: photosNavRail({
        shelf: "collection-7",
        counts: photosCounts,
        onSelect: route,
      }),
    }),
    createElement(Pane, {
      id: "docs",
      label: "Docs",
      // Standing in a folder: that folder is current, Folders stays reachable.
      items: docsNavRail({
        shelf: "folder:f-property",
        counts: docsCounts,
        folders,
        activeDocs,
        onSelect: route,
      }),
    }),
    createElement("button", { type: "button", id: "after" }, "after")
  )
);
`;

/** Bundle the shipped rail, its CSS modules included, for the browser. */
async function bundleRail(): Promise<{ js: string; css: string }> {
  const result = await build({
    stdin: {
      contents: ENTRY,
      resolveDir: here,
      loader: "tsx",
      sourcefile: "app-navigation-rail-harness.tsx",
    },
    bundle: true,
    write: false,
    // Never written (`write: false`); esbuild needs a path to name the CSS-module output against.
    outdir: path.join(here, ".app-navigation-rail-bundle"),
    format: "iife",
    jsx: "automatic",
    platform: "browser",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return {
    css:
      result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "",
    js:
      result.outputFiles.find((file) => file.path.endsWith(".js"))?.text ?? "",
  };
}

/** The pane geometry the two apps' own `Chrome.module.css` gives the row: a
 *  bounded flex row whose scroller is the only column that gives width back. */
const HARNESS_CSS = `
  body { margin: 0; background: var(--bg); color: var(--text); }
  .seat { display: flex; flex-direction: column; gap: 0; height: 100vh; }
  .pane {
    flex: 1; min-height: 0; display: flex;
    border-block-end: 1px solid var(--line);
    --content-margin: var(--page-margin);
  }
  .scroller { flex: 1; min-width: 0; min-height: 0; overflow: auto;
              padding: 2px var(--content-margin) 40px; }
  .grid { display: flex; flex-wrap: wrap; gap: 12px; }
  .tile { inline-size: ${TILE}px; block-size: ${TILE}px; background: var(--bg-sunken); }
  #before, #after { block-size: 1px; opacity: 0; }
`;

test("the app rail holds its width, scrolls itself, and is one tab stop", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { js, css } = await bundleRail();

  await page.setViewportSize({ height: 900, width: 1420 });
  await page.setContent(
    `<style>${toBlueprintCss()}</style><style>${css}</style>` +
      `<style>${HARNESS_CSS}</style>` +
      `<body><div id="root"></div></body>`
  );
  await page.addScriptTag({ content: js });

  const photos = page.getByRole("navigation", { name: "Photos" });
  const docs = page.getByRole("navigation", { name: "Docs" });
  await expect(photos).toBeVisible();
  await expect(docs).toBeVisible();

  // ── The rail is exactly the token on both apps, not resizable by adjacent content.
  const widthOf = async (nav: typeof photos): Promise<number> =>
    (await nav.boundingBox())?.width ?? 0;
  expect(await widthOf(photos)).toBe(metrics.appRail);
  expect(await widthOf(docs)).toBe(metrics.appRail);

  // ── Pointer row rung via a real `(pointer: fine)` query; coarse keeps the 44 floor.
  const rowHeight = await page
    .getByRole("navigation", { name: "Photos" })
    .getByRole("button", { name: /Library/u })
    .first()
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(Math.round(rowHeight)).toBe(metrics.appRailRow);

  // ── Where the member is standing, on both spines at once.
  await expect(photos.locator('[aria-current="page"]')).toHaveText(/Albums/u);
  await expect(docs.locator('[aria-current="page"]')).toHaveText(/Property/u);
  await expect(docs.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(docs.getByRole("button", { name: /^Folders/u })).toBeVisible();

  // ── AT 1090 THE RAIL HOLDS ITS WIDTH AND THE GRID REFLOWS.
  const tilesPerRow = async (): Promise<number> =>
    page.evaluate(() => {
      const tiles = [
        ...document.querySelectorAll<HTMLElement>("#photos .tile"),
      ];
      const top = tiles[0]?.getBoundingClientRect().top;
      return tiles.filter((tile) => tile.getBoundingClientRect().top === top)
        .length;
    });
  const wide = await tilesPerRow();
  await page.setViewportSize({ height: 900, width: 1090 });
  const packed = await tilesPerRow();
  expect(await widthOf(photos)).toBe(metrics.appRail);
  expect(packed).toBeLessThan(wide);
  await page.setViewportSize({ height: 900, width: 1420 });

  // ── THE RAIL AND THE CONTENT COLUMN SCROLL INDEPENDENTLY, either direction.
  const scroller = page.locator('#photos [data-scroller="Photos"]');
  await scroller.evaluate((el) => {
    el.scrollTop = 400;
  });
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await photos.evaluate((el) => el.scrollTop)).toBe(0);

  // ── ONE TAB STOP INTO THE RAIL, then up/down through the rows.
  await page.locator("#before").focus();
  await page.keyboard.press("Tab");
  const entered = await page.evaluate(
    () => document.activeElement?.textContent ?? ""
  );
  expect(entered).toContain("Albums");
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(
      () =>
        document.activeElement?.closest("nav")?.getAttribute("aria-label") ?? ""
    )
  ).not.toBe("Photos");

  // ── UP/DOWN MOVES, ENTER ROUTES.
  await photos.getByRole("button", { name: /^Library/u }).focus();
  await page.keyboard.press("ArrowDown");
  expect(
    await page.evaluate(() => document.activeElement?.textContent ?? "")
  ).toContain("Favorites");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => window.__routed)).toHaveLength(1);

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    fullPage: true,
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
  });
});
