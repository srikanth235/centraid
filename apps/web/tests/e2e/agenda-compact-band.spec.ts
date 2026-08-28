import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { build } from "esbuild";

import { toCss } from "@centraid/design";

// AGENDA'S COMPACT BAND on the web seat (#882): UI-impact evidence, and the
// regression test for the defect behind it. The band used to offer Month, which
// is absent by type on a phone — pressing it drew the DAY grid and lit the DAY
// tab, so the band named one place and the canvas showed another. Month is gone
// and Search took the slot, which is load-bearing in the other direction: the
// app bar withdraws its own Search on compact BELIEVING the band carries it, so
// a band without Search would leave the seat with no way into search at all.
//
// The SHIPPED Agenda `Root` mounts against a stubbed `window.centraid`, its
// frame contributions render through the shipped shell `AppBand` — nothing
// about the band or the views is reimplemented here.

const here = import.meta.dirname;
const REPO_ROOT = path.resolve(here, "../../../..");
const KIT_CSS = path.join(REPO_ROOT, "packages/design/src/elements/kit.css");
const AGENDA_ROOT = path.join(
  REPO_ROOT,
  "packages/blueprints/apps/agenda/app-root.tsx"
);
const APP_BAND = path.join(
  REPO_ROOT,
  "packages/client/src/react/shell/AppBand.tsx"
);
const EVIDENCE_DIR = path.join(REPO_ROOT, "artifacts/e2e/ui-impact");
const EVIDENCE_PNG = "issue-882-agenda-compact-band.png";

/** Agenda's own copy (`agenda/view-copy.ts`), quoted where it is asserted. */
const BAND_TABS = ["Day", "Schedule", "Waiting on", "Search", "More"];
const SEARCH_LABEL = "Search agenda";
const AWAITING = "No answer yet";

/** The seat the shell gives an inline app: a bar fed by `setAppBar`, the app,
 *  and the claimed band under it. `compact` is the shell's own answer. */
const entry = (compact: boolean): string => `
import { createElement, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Root } from ${JSON.stringify(AGENDA_ROOT)};
import AppBand from ${JSON.stringify(APP_BAND)};

// Two events today, one of them unanswered — so Schedule and Waiting on hold
// different rows and a view that draws the wrong one is visible as such.
const start = new Date();
start.setHours(9, 0, 0, 0);
const at = (hours) => new Date(start.getTime() + hours * 3600000).toISOString();

const EVENTS = [
  {
    event_id: "ev-survey",
    calendar_id: "cal-personal",
    summary: "Roof survey",
    dtstart: at(0),
    dtend: at(1),
  },
  {
    event_id: "ev-handover",
    calendar_id: "cal-personal",
    summary: "Key handover",
    dtstart: at(3),
    dtend: at(4),
    attendees: [
      { party_id: "p-me", name: "Me", partstat: "needs-action", is_you: true },
    ],
  },
];

window.centraid = {
  read: async ({ query }) => {
    if (query === "upcoming")
      return {
        events: EVENTS,
        calendars: [{ calendar_id: "cal-personal", name: "Personal" }],
      };
    if (query === "parties") return { parties: [], me: "p-me" };
    return {};
  },
  write: async () => ({ status: "executed" }),
};

function Seat() {
  const [bar, setBar] = useState(null);
  const [claim, setClaim] = useState(null);
  // Stable for the mount, as the contract requires: it sits in Root's deps.
  const frame = useRef(null);
  frame.current ??= {
    setAppBar: setBar,
    setStatus: () => {},
    clearStatus: () => {},
    claimBand: setClaim,
  };
  return createElement(
    "div",
    { className: "seat" },
    createElement(
      "header",
      { className: "bar", id: "appbar" },
      createElement("span", null, bar && bar.title ? bar.title : "Agenda"),
      createElement("div", { className: "barActions" }, bar ? bar.actions : null)
    ),
    createElement(
      "div",
      { className: "pane centraid-inline-scope" },
      createElement(Root, {
        rootRef: () => {},
        frame: frame.current,
        compact: ${String(compact)},
      })
    ),
    claim
      ? createElement(AppBand, { claim, appName: "Agenda", onHome: () => {} })
      : null
  );
}

createRoot(document.getElementById("root")).render(createElement(Seat));
`;

async function bundle(
  contents: string,
  name: string
): Promise<{ css: string; js: string }> {
  const result = await build({
    stdin: { contents, loader: "tsx", resolveDir: here, sourcefile: name },
    bundle: true,
    define: { "process.env.NODE_ENV": '"production"' },
    format: "iife",
    jsx: "automatic",
    // Never written (`write: false`); esbuild needs a path to name CSS output.
    outdir: path.join(here, `.${name}-bundle`),
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

/** The bar and band are the frame's; the pane is the only column that gives
 *  width back, which is what Agenda's own width observer measures. */
const HARNESS_CSS = `
  body { margin: 0; background: var(--bg); color: var(--text); }
  .seat { display: flex; flex-direction: column; height: 100vh; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
         border-block-end: 1px solid var(--line); }
  .barActions { display: flex; align-items: center; gap: 8px;
                margin-inline-start: auto; }
  .pane { flex: 1; min-width: 0; min-height: 0; display: flex; }
`;

async function mount(
  page: Page,
  compact: boolean,
  width: number
): Promise<void> {
  const name = `agenda-band-${compact ? "compact" : "pointer"}-harness`;
  const [{ css, js }, kitCss] = await Promise.all([
    bundle(entry(compact), name),
    readFile(KIT_CSS, "utf8"),
  ]);
  await page.setViewportSize({ height: 844, width });
  await page.setContent(
    `<style>${toCss()}</style><style>${kitCss}</style>` +
      `<style>${css}</style><style>${HARNESS_CSS}</style>` +
      `<body><div id="root"></div></body>`
  );
  await page.addScriptTag({ content: js });
}

test("Agenda's compact band offers Search, never Month, and lands where it says", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await mount(page, true, 390);

  const band = page.locator('nav[data-band="app"]');
  const tab = (name: string): ReturnType<typeof band.getByRole> =>
    band.getByRole("button", { exact: true, name });
  const current = band.locator('[aria-current="page"]');
  const grid = page.locator("[data-columns]");
  const rows = page.locator("[data-event-id]");
  const awaiting = page.getByText(AWAITING);
  const barSearch = page.locator(`#appbar button[aria-label="${SEARCH_LABEL}"]`);

  // ── The four destinations plus the frame's More. Month is absent BY TYPE:
  // seven columns at 390px are unreadable, and a tab that draws another view is
  // worse than a tab that is not there.
  await expect(band).toBeVisible();
  await expect(band.locator("fieldset button")).toHaveText(BAND_TABS);
  await expect(tab("Month")).toHaveCount(0);

  // ── Pressing a destination lands on the view it NAMES — canvas and lit tab
  // agreeing. Schedule and Waiting on are lists; only Day draws a grid.
  await expect(current).toHaveText("Day");
  await expect(grid).toHaveAttribute("data-columns", "1");

  await tab("Schedule").click();
  await expect(current).toHaveText("Schedule");
  await expect(grid).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  await expect(awaiting).toHaveCount(0);

  await tab("Waiting on").click();
  await expect(current).toHaveText("Waiting on");
  await expect(grid).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(awaiting).toHaveCount(1);

  await tab("Day").click();
  await expect(current).toHaveText("Day");
  await expect(grid).toHaveAttribute("data-columns", "1");

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    fullPage: true,
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
  });

  // ── The bar withdrew its own Search here, so the band's Search is the only
  // way in — and it opens a FIELD rather than becoming a fifth view: the canvas
  // and the lit tab both stay where they were.
  await expect(barSearch).toHaveCount(0);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await tab("Search").click();
  await expect(page.getByRole("searchbox", { name: SEARCH_LABEL })).toBeVisible();
  await expect(current).toHaveText("Day");
  await expect(grid).toHaveAttribute("data-columns", "1");

  // A closed field that still filters would be a hidden filter.
  await page.getByRole("button", { exact: true, name: "Close" }).click();
  await expect(page.getByRole("searchbox")).toHaveCount(0);

  // ── The withdrawal is a SWAP, not a loss: off compact the bar carries Search
  // itself and no band is claimed at all.
  await mount(page, false, 1280);
  await expect(barSearch).toHaveCount(1);
  await expect(page.locator('nav[data-band="app"]')).toHaveCount(0);
});
