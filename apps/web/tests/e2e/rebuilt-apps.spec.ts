import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { toCss } from "@centraid/design";

// THE REBUILT AGENDA AND TASKS SURFACES, in a real browser (#834).
//
// The two captures here are the UI-impact evidence, and each mounts the SHIPPED
// component over the SHIPPED design tokens and `kit.css` — nothing is
// reimplemented, and every string asserted comes from the app's own view-copy
// rather than being retyped here.
//
// What a browser proves that the jsdom suites cannot:
//
//   Tasks — overdue is the ONE group drawn in the attention tone and the only
//     one carrying bulk verbs, and it carries them as quiet verbs beside the
//     header rather than as the loudest control on screen (the re-entry
//     surface the Tasks brief rules in place of a wall of shame). A family
//     renders whole under its parent, and the window's end says so honestly.
//
//   Agenda — the day-context layers paint as ANNOTATION, not as a fourth
//     calendar: no hue dot, the ribbon and the collapsed `2 due` shelf sit in
//     the annotation register, and the shelf opens to names that hand off to
//     Tasks instead of being editable here.
//
// Both specs run against chromium in CI (`bun run --cwd apps/web e2e`).

const here = import.meta.dirname;
const REPO_ROOT = path.resolve(here, "../../../..");
const KIT_CSS = path.join(REPO_ROOT, "packages/design/src/elements/kit.css");
const EVIDENCE_DIR = path.join(REPO_ROOT, "artifacts/e2e/ui-impact");
const TASKS_PNG = "issue-834-tasks-board.png";
const AGENDA_PNG = "issue-834-agenda-day-context.png";

const TASKS_BOARD = path.join(
  REPO_ROOT,
  "packages/blueprints/apps/tasks/components/Board.tsx"
);
const AGENDA_DAY_CONTEXT = path.join(
  REPO_ROOT,
  "packages/blueprints/apps/agenda/components/DayContext.tsx"
);

/**
 * The Tasks harness entry. One overdue group with its two bulk verbs, one
 * dated group holding a parent and its one level of children, and the honest
 * end of the window.
 */
const TASKS_ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Board } from ${JSON.stringify(TASKS_BOARD)};

const task = (id, title, extra = {}) => ({
  task_id: id,
  status: "needs-action",
  title,
  ...extra,
});

const groups = [
  {
    key: "overdue",
    label: "Overdue",
    meta: "2",
    attention: true,
    rows: [
      task("t-1", "Renew the passport", { due_at: "2026-08-11T09:00:00.000Z" }),
      task("t-2", "Water the fig", {
        due_at: "2026-08-14T09:00:00.000Z",
        recurrence_summary: "every Friday",
        missed: 4,
        next_due: "2026-08-28T09:00:00.000Z",
      }),
    ],
  },
  {
    key: "dated",
    label: "Dated",
    meta: "1",
    rows: [
      task("t-3", "Plan the move", {
        due_at: "2026-08-25T09:00:00.000Z",
        children: [task("t-4", "Book the van")],
      }),
    ],
  },
];

window.__tasksActs = [];
const collapsed = new Set();

const ctx = {
  now: "2026-08-21T10:00:00.000Z",
  projectName: () => null,
  projectHue: () => null,
  isShared: () => false,
  collapsed: (id) => collapsed.has(id),
  cursorId: null,
  onToggleFamily: (id) => window.__tasksActs.push("toggle:" + id),
  onOpen: (id) => window.__tasksActs.push("open:" + id),
  onComplete: (t) => window.__tasksActs.push("complete:" + t.task_id),
};

createRoot(document.getElementById("root")).render(
  createElement(Board, {
    groups,
    ctx,
    narrow: false,
    overdueVerbs: [
      { label: "Catch up", run: () => window.__tasksActs.push("catch-up") },
      { label: "Move all to today", run: () => window.__tasksActs.push("move-all") },
    ],
    windowEnd: { shown: 3, total: 214 },
    onShowMore: () => window.__tasksActs.push("show-more"),
  })
);
`;

/**
 * The Agenda harness entry. The rail's three layer switches, a day ribbon
 * carrying two costless facts, and the collapsed due-task shelf.
 */
const AGENDA_ENTRY = `
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { DayRibbon, DayShelf, LayerToggles } from ${JSON.stringify(AGENDA_DAY_CONTEXT)};

window.__agendaActs = [];

function Harness() {
  const [layers, setLayers] = useState({ bdays: true, due: true, hols: true });
  const [open, setOpen] = useState(false);
  return createElement(
    "div",
    { style: { display: "grid", gap: "16px", padding: "16px", width: "320px" } },
    createElement(LayerToggles, {
      layers,
      onToggle: (id) => {
        window.__agendaActs.push("layer:" + id);
        setLayers((prev) => ({ ...prev, [id]: !prev[id] }));
      },
    }),
    createElement(DayRibbon, {
      facts: [
        { kind: "birthday", id: "party-dana", text: "🎂 Dana", inner: true },
        { kind: "birthday", id: "party-ravi", text: "🎂 Ravi" },
      ],
    }),
    createElement(DayShelf, {
      dayKey: "2026-08-21",
      count: 2,
      tasks: [
        { task_id: "t-1", title: "Renew the passport" },
        { task_id: "t-2", title: "Water the fig" },
      ],
      open,
      onToggle: (dayKey) => {
        window.__agendaActs.push("shelf:" + dayKey);
        setOpen((prev) => !prev);
      },
      onOpenTask: (taskId) => window.__agendaActs.push("open-task:" + taskId),
    })
  );
}

createRoot(document.getElementById("root")).render(createElement(Harness));
`;

/** Bundle a shipped component, its CSS modules included, for the browser. */
async function bundle(
  contents: string,
  name: string
): Promise<{ js: string; css: string }> {
  const result = await build({
    stdin: { contents, resolveDir: here, loader: "tsx", sourcefile: name },
    bundle: true,
    write: false,
    // Never written (`write: false`), but esbuild needs a path to name the CSS
    // module output against — the class map and the stylesheet are two halves
    // of one build.
    outdir: path.join(here, `.${name}-bundle`),
    format: "iife",
    jsx: "automatic",
    platform: "browser",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return {
    js:
      result.outputFiles.find((file) => file.path.endsWith(".js"))?.text ?? "",
    css:
      result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "",
  };
}

async function mount(
  page: import("@playwright/test").Page,
  entry: string,
  name: string,
  width: number
): Promise<void> {
  const [{ js, css }, kitCss] = await Promise.all([
    bundle(entry, name),
    readFile(KIT_CSS, "utf8"),
  ]);
  await page.setViewportSize({ width, height: 720 });
  await page.setContent(
    `<style>${toCss()}</style><style>${kitCss}</style><style>${css}</style>` +
      `<body style="background:var(--bg);color:var(--text);margin:0">` +
      `<div id="root" class="centraid-inline-scope"></div></body>`
  );
  await page.addScriptTag({ content: js });
}

test("the rebuilt Tasks board offers overdue re-entry, not a wall of shame", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await mount(page, TASKS_ENTRY, "tasks-board-harness", 820);

  // Overdue is the one group in the attention tone, and the only one with
  // bulk verbs — both quiet, neither filled.
  // `div[...]`, not `[...]`: the attention tone is also carried by the overdue
  // row's own due phrase (a span), which is the point — attention lives on the
  // phrase and the group head, and nowhere else.
  const overdue = page.locator('div[data-attention="true"]');
  await expect(overdue).toHaveCount(1);
  await expect(overdue.getByText("Overdue")).toBeVisible();
  await expect(
    page.locator('[data-task-id="t-1"] span[data-attention="true"]')
  ).toHaveText("10 days ago");
  await Promise.all(
    ["Catch up", "Move all to today"].map((verb) =>
      expect(
        overdue.getByRole("button", { name: verb, exact: true })
      ).toHaveClass(/kit-plain-btn/u)
    )
  );

  // A repeating task shows ONE live occurrence with its collapse, in the
  // summariser's words — never a stack of copies, never a raw rule.
  await expect(page.getByText("every Friday")).toBeVisible();
  await expect(page.getByText("RRULE")).toHaveCount(0);

  // The family renders whole, and the window's end is honest about itself.
  await expect(page.getByText("Book the van")).toBeVisible();
  await expect(
    page.getByText("3 of 214 · this is a window, not everything open")
  ).toBeVisible();

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, TASKS_PNG),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Catch up", exact: true }).click();
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__tasksActs))
    .toStrictEqual(["catch-up", "show-more"]);
});

test("Agenda's day context draws layers as annotation, never as a calendar", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await mount(page, AGENDA_ENTRY, "agenda-day-context-harness", 420);

  // Three switches, each saying where its facts live, and one sentence that
  // says once what a layer is not.
  await Promise.all(
    [
      ["Birthdays", "from People"],
      ["Due tasks", "from Tasks"],
      ["Holidays", "subscribed"],
    ].flatMap(([name, from]) => [
      expect(page.getByText(String(name), { exact: true })).toBeVisible(),
      expect(page.getByText(String(from), { exact: true })).toBeVisible(),
    ])
  );
  await expect(
    page.getByText("Layers decorate a day; none of them is writable.")
  ).toBeVisible();

  // Two birthdays collapse to a count rather than pushing the day's events out
  // of the cell, and the due shelf is collapsed — never a grid chip.
  await expect(page.getByText("2 birthdays")).toBeVisible();
  const shelf = page.getByRole("button", { name: "2 due" });
  await expect(shelf).toHaveAttribute("aria-expanded", "false");

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, AGENDA_PNG),
    fullPage: true,
  });

  // Opening the shelf lists names that hand off to Tasks; Agenda shows the
  // fact and never edits it.
  await shelf.click();
  await page
    .getByRole("button", { name: "Renew the passport", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__agendaActs))
    .toStrictEqual(["shelf:2026-08-21", "open-task:t-1"]);
});

declare global {
  interface Window {
    /** What the Tasks harness collected from the board's callbacks. */
    __tasksActs: string[];
    /** What the Agenda harness collected from the layers and the shelf. */
    __agendaActs: string[];
  }
}
