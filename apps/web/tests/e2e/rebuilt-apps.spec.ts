import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { toCss } from "@centraid/design";

// REBUILT AGENDA AND TASKS SURFACES in a real browser (#834): UI-impact
// evidence. Each capture mounts the SHIPPED component over shipped tokens and
// `kit.css`; asserted strings come from the app's own view-copy.
//   Tasks — overdue is the ONE attention-tone group, with quiet bulk verbs
//     (re-entry, not a wall of shame); families render whole.
//   Agenda — layers paint as ANNOTATION, never a fourth calendar; the shelf
//     hands off to Tasks.
//
// Runs against chromium in CI (`bun run --cwd apps/web e2e`).

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

/** Tasks harness: one overdue group with verbs, one parent/child, window end. */
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

/** Agenda harness: layer switches, day ribbon, collapsed due shelf. */
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

/** Bundle a shipped component, CSS modules included, for the browser. */
async function bundle(
  contents: string,
  name: string
): Promise<{ js: string; css: string }> {
  const result = await build({
    stdin: { contents, resolveDir: here, loader: "tsx", sourcefile: name },
    bundle: true,
    write: false,
    // Never written (`write: false`), but esbuild needs a path for the CSS
    // module output name.
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

  // Overdue: one attention-tone group, quiet bulk verbs. `div[...]`, not
  // `[...]`: attention also lives on the row's own due phrase.
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

  // ONE live occurrence with its collapse, in the summariser's words.
  await expect(page.getByText("every Friday")).toBeVisible();
  await expect(page.getByText("RRULE")).toHaveCount(0);

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

  // Three switches naming where facts live; layers are not writable here.
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

  // Birthdays collapse to a count; the due shelf starts collapsed.
  await expect(page.getByText("2 birthdays")).toBeVisible();
  const shelf = page.getByRole("button", { name: "2 due" });
  await expect(shelf).toHaveAttribute("aria-expanded", "false");

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, AGENDA_PNG),
    fullPage: true,
  });

  // The shelf lists names that hand off to Tasks; Agenda never edits.
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
    /** Collected from the board's callbacks. */
    __tasksActs: string[];
    /** Collected from the layers and the shelf. */
    __agendaActs: string[];
  }
}
