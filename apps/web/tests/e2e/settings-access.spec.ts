import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { toCss } from "@centraid/design";

// SETTINGS → ACCESS AS THE ONE DASHBOARD, in a real browser (#928): the
// shipped screen with its loader stubbed. A browser proves what jsdom cannot —
// that an automation now reads as a principal beside people and devices, that
// every row says when it was last used, and that an ask the owner has not
// answered is drawn above the answers rather than hidden behind them.

const here = import.meta.dirname;
const REPO_ROOT = path.resolve(here, "../../../..");
const KIT_CSS = path.join(REPO_ROOT, "packages/design/src/elements/kit.css");
const SCREEN = path.join(
  REPO_ROOT,
  "packages/client/src/react/screens/SettingsAccessScreen.tsx"
);
const EVIDENCE_DIR = path.join(REPO_ROOT, "artifacts/e2e/ui-impact");
const EVIDENCE_PNG = "issue-928-settings-access.png";

/** Harness entry: the SHIPPED screen, with its one loader stubbed. */
const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import SettingsAccessScreen from ${JSON.stringify(SCREEN)};

const answer = (over) => ({
  authorityId: "a-" + over.principalId + "-" + over.subjectId,
  subjectType: "core.document",
  subjectId: "doc-1",
  verb: "view",
  decision: "granted",
  duration: "standing",
  expiresAt: null,
  grantedAt: "2026-03-02T09:00:00.000Z",
  revokedAt: null,
  lastUsedAt: null,
  ...over,
});

const lens = {
  status: "ready",
  loci: {
    local: "it stops on the next run, and nothing already read comes back.",
  },
  requests: [
    {
      requestId: "req-1",
      principalId: "receipts",
      scopes: ["tally.expense · read", "core.content_item · read"],
      requestedAt: "2026-09-01T08:00:00.000Z",
    },
  ],
  groups: [
    {
      id: "audiences",
      title: "People and circles",
      locus: "remote",
      answers: [
        answer({
          principalKind: "person",
          principalId: "Priya",
          lastUsedAt: "2026-08-30T18:20:00.000Z",
        }),
      ],
    },
    { id: "harnesses", title: "Harnesses", locus: "local", answers: [] },
    {
      id: "automations",
      title: "Automations",
      locus: "local",
      answers: [
        answer({
          principalKind: "automation",
          principalId: "digest",
          subjectType: "automation.pack",
          subjectId: "schedule",
          verb: "read",
          lastUsedAt: "2026-09-03T06:05:00.000Z",
        }),
        answer({
          principalKind: "automation",
          principalId: "receipts",
          subjectType: "automation.pack",
          subjectId: "tally",
          verb: "read",
        }),
      ],
    },
    {
      id: "devices",
      title: "Your devices",
      locus: "boundary",
      answers: [
        answer({
          principalKind: "device",
          principalId: "Priya's phone",
          subjectType: "core.vault",
          subjectId: "",
          verb: "edit",
          lastUsedAt: "2026-09-04T07:41:00.000Z",
        }),
      ],
    },
  ],
};

createRoot(document.getElementById("root")).render(
  createElement(SettingsAccessScreen, { load: () => Promise.resolve(lens) })
);
`;

/** Bundle the shipped screen, CSS modules included, for the browser. */
async function bundleScreen(): Promise<{ js: string; css: string }> {
  const result = await build({
    stdin: {
      contents: ENTRY,
      resolveDir: here,
      loader: "tsx",
      sourcefile: "settings-access-harness.tsx",
    },
    bundle: true,
    write: false,
    // Never written (`write: false`); esbuild needs a path to name the CSS
    // output against.
    outdir: path.join(here, ".settings-access-bundle"),
    format: "iife",
    jsx: "automatic",
    platform: "browser",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const js = result.outputFiles.find((file) => file.path.endsWith(".js"));
  const css = result.outputFiles.find((file) => file.path.endsWith(".css"));
  return { js: js?.text ?? "", css: css?.text ?? "" };
}

test("Access lists automations beside people, dates every row, and shows the open ask", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const [{ js, css }, kitCss] = await Promise.all([
    bundleScreen(),
    readFile(KIT_CSS, "utf8"),
  ]);

  await page.setViewportSize({ width: 900, height: 1000 });
  await page.setContent(
    `<style>${toCss()}</style><style>${kitCss}</style><style>${css}</style>` +
      `<body style="background:var(--bg);color:var(--text);margin:0">` +
      `<div id="root" class="centraid-inline-scope"></div></body>`
  );
  await page.addScriptTag({ content: js });

  // An automation is a principal like any other since #928.
  await expect(page.getByText("Automations")).toBeVisible();
  await expect(
    page.getByText("digest may read", { exact: false })
  ).toBeVisible();

  // NEVER USED IS A FACT, NOT A BLANK: the answer nothing has exercised says so.
  await expect(page.getByText("never used").first()).toBeVisible();
  await expect(page.getByText(/last used/u).first()).toBeVisible();

  // An ask is not an answer, and it is not hidden either.
  await expect(page.getByText("Waiting on you")).toBeVisible();
  await expect(
    page.getByText("receipts is asking for", { exact: false })
  ).toBeVisible();

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
    fullPage: true,
  });
});
