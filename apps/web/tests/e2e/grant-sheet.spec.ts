import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { toCss } from "@centraid/design";

// The GRANT SHEET in a real browser (#825, wave 4).
//
// The kit is not wired into an app yet — the app waves do that — so this spec
// mounts the shipped component itself, over the shipped design tokens and the
// shipped `kit.css`, with the grant plane stubbed at the ONE seam the kit was
// built to take: its `door`. That is deliberately the whole point of the seam.
// What a browser proves here that a jsdom suite cannot: the sheet's real
// `<dialog>` paints, the tokens resolve, the segmented capability picker and
// the outlined destructive control render as the recipes say, and the
// destructive confirm reads in its own words.
//
// The capture is the #825 UI-impact evidence.

declare global {
  interface Window {
    /** What the harness collected from the sheet's one feedback channel. */
    __grantStatus: string[];
  }
}

const here = import.meta.dirname;
const REPO_ROOT = path.resolve(here, "../../../..");
const KIT_CSS = path.join(REPO_ROOT, "packages/design/src/elements/kit.css");
const SHEET = path.join(
  REPO_ROOT,
  "packages/blueprints/apps/_shared/GrantSheet.tsx"
);
const EVIDENCE_DIR = path.join(REPO_ROOT, "artifacts/e2e/ui-impact");
const EVIDENCE_PNG = "issue-825-grant-sheet.png";

/**
 * The harness entry. It imports the SHIPPED sheet — nothing is reimplemented
 * here — and hands it a door whose answers cover the three states the sheet
 * has to tell apart: a delivered grant, one still waiting on an invitation,
 * and one addressed to no vault at all.
 */
const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { GrantSheet } from ${JSON.stringify(SHEET)};

const grant = (id, subjectType, capability, fulfillment) => ({
  grantId: id,
  audience: { kind: "party", id: "party-priya" },
  subjectType,
  subjectId: id,
  capability,
  grantedAt: "2026-08-01T10:00:00.000Z",
  revokedAt: null,
  grantedBy: "party-owner",
  maxSizeBytes: null,
  fulfillment,
});

const door = {
  subjects: () =>
    Promise.resolve({
      readable: true,
      offers: [
        { subjectType: "core.document", capabilities: ["view", "edit"] },
        { subjectType: "media.asset", capabilities: ["view"] },
      ],
    }),
  forParty: () =>
    Promise.resolve({
      known: true,
      channel: { state: "live" },
      grants: [
        grant("doc-1", "core.document", "edit", [
          { peerVaultId: "vault-priya", state: "delivered", updatedAt: "", detail: null },
        ]),
        grant("photo-1", "media.asset", "view", [
          { peerVaultId: "vault-priya", state: "awaiting_channel", updatedAt: "", detail: null },
        ]),
        grant("album-1", "core.collection", "view", []),
      ],
    }),
  forAudience: () => Promise.resolve({ known: true, grants: [] }),
  forSubject: () => Promise.resolve([]),
  create: () => Promise.resolve({ ok: true, outcome: "created" }),
  revoke: () =>
    Promise.resolve({
      ok: true,
      message:
        "no longer shared; a vault holding a copy has been asked to remove it and has not yet confirmed",
    }),
};

window.__grantStatus = [];

createRoot(document.getElementById("root")).render(
  createElement(GrantSheet, {
    open: true,
    onClose: () => undefined,
    onStatus: (message) => window.__grantStatus.push(message),
    audiences: [
      { kind: "party", id: "party-priya", label: "Priya" },
      { kind: "party", id: "party-ravi", label: "Ravi" },
      { kind: "circle", id: "circle-1", label: "Ski trip" },
    ],
    subjects: [
      { subjectType: "core.document", subjectId: "doc-2", label: "Trip plan" },
      { subjectType: "media.asset", subjectId: "photo-2", label: "Beach" },
    ],
    door,
  })
);
`;

/** Bundle the shipped sheet, its CSS module included, for the browser. */
async function bundleSheet(): Promise<{ js: string; css: string }> {
  const result = await build({
    stdin: {
      contents: ENTRY,
      resolveDir: here,
      loader: "tsx",
      sourcefile: "grant-sheet-harness.tsx",
    },
    bundle: true,
    write: false,
    // Never written (`write: false`), but esbuild needs a path to name the
    // sheet's CSS-module output against — the class map and the stylesheet are
    // two halves of one build.
    outdir: path.join(here, ".grant-sheet-bundle"),
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

test("the grant sheet draws audience-first over the shipped tokens", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const [{ js, css }, kitCss] = await Promise.all([
    bundleSheet(),
    readFile(KIT_CSS, "utf8"),
  ]);

  await page.setViewportSize({ width: 900, height: 900 });
  await page.setContent(
    `<style>${toCss()}</style><style>${kitCss}</style><style>${css}</style>` +
      `<body style="background:var(--bg);color:var(--text);margin:0">` +
      `<div id="root" class="centraid-inline-scope"></div></body>`
  );
  await page.addScriptTag({ content: js });

  const dialog = page.locator("dialog.kit-modal-back");
  await expect(dialog).toBeVisible();

  // Person → what → capability, in that order (ruling G-audience).
  await expect(page.getByText("Person", { exact: true })).toBeVisible();
  await expect(page.getByText("What", { exact: true })).toBeVisible();
  await expect(page.getByText("Access", { exact: true })).toBeVisible();

  // `edit` is drawn because the declared registry answers it for a document.
  await expect(page.getByRole("button", { name: "Can edit" })).toBeVisible();

  // Three delivery states, three sentences — absent is never empty. And the
  // reach line reports the channel the read actually answered: a person this
  // vault reaches is never told sharing sends an invitation first.
  await expect(page.getByText("Delivered")).toBeVisible();
  await expect(page.getByText("Invitation pending")).toBeVisible();
  await expect(page.getByText("Not sent yet")).toBeVisible();
  await expect(page.locator('[data-reach="live"]')).toBeVisible();
  await expect(page.getByText("Not reached yet")).toHaveCount(0);

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
    fullPage: true,
  });

  // Revoking asks first, in the honest best-effort words: a removal crossing
  // to someone else's vault is REQUESTED, never guaranteed.
  await page.getByRole("button", { name: "Revoke" }).first().click();
  await expect(page.getByText("Stop sharing with Priya?")).toBeVisible();
  await expect(
    page.getByText("their vault is asked to remove its copy", { exact: false })
  ).toBeVisible();

  // Destructive is OUTLINED in `--net`; the filled primary is gone from this
  // view entirely, so nothing in it competes with the consequence.
  const confirm = page.getByRole("button", { name: "Revoke", exact: true });
  await expect(confirm).toHaveClass(/destructive/u);
  await expect(page.locator("button.kit-btn.primary")).toHaveCount(0);

  await confirm.click();
  // The route's derived sentence reaches the host's status line verbatim.
  await expect
    .poll(() => page.evaluate(() => window.__grantStatus))
    .toStrictEqual([
      "no longer shared; a vault holding a copy has been asked to remove it and has not yet confirmed",
    ]);
});
