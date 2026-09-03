import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { toCss } from "@centraid/design";

declare global {
  interface Window {
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

const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { GrantSheet } from ${JSON.stringify(SHEET)};

// The phrase and the reason ride the WIRE now (#883, ruling V-phrases): the
// vault derives both from the fulfillment rows and the sheet prints them
// verbatim, where the sheet used to read the rows and write its own label. The
// values below are the ones grantPhrase (packages/vault/src/grant/phrases.ts)
// yields for each row set here, so a door stub cannot narrate a state the vault
// would have described differently.
const grant = (id, subjectType, capability, fulfillment, phrase, reason) => ({
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
  phrase,
  reason,
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
        grant(
          "doc-1",
          "core.document",
          "edit",
          [
            { peerVaultId: "vault-priya", state: "delivered", updatedAt: "", detail: null },
          ],
          "shared",
          "the vault it addresses is holding it"
        ),
        grant(
          "photo-1",
          "media.asset",
          "view",
          [
            { peerVaultId: "vault-priya", state: "awaiting_channel", updatedAt: "", detail: null },
          ],
          "on its way",
          "there is no way to reach them yet; the ask is recorded"
        ),
        grant(
          "album-1",
          "core.collection",
          "view",
          [],
          "on its way",
          "no vault has been addressed for it yet"
        ),
      ],
    }),
  forAudience: () => Promise.resolve({ known: true, grants: [] }),
  forSubject: () => Promise.resolve([]),
  create: () => Promise.resolve({ ok: true, outcome: "created" }),
  // Withdraw-then-grant is the only way the plane changes a standing answer
  // (ruling V-table); the door carries it, so the stub has to as well or the
  // sheet is handed a door the shipped one is not.
  changeCapability: () => Promise.resolve({ ok: true, outcome: "created" }),
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

  await expect(page.getByText("Person", { exact: true })).toBeVisible();
  await expect(page.getByText("What", { exact: true })).toBeVisible();
  await expect(page.getByText("Access", { exact: true })).toBeVisible();

  await expect(page.getByRole("button", { name: "Can edit" })).toBeVisible();

  await expect(page.locator('[data-phrase="shared"]')).toHaveText(
    "Can edit · Shared"
  );
  await expect(page.locator('[data-phrase="on its way"]')).toHaveCount(2);
  await expect(page.locator('[data-phrase="on its way"]').first()).toHaveText(
    "Can view · On its way"
  );
  await expect(
    page.getByText("the vault it addresses is holding it")
  ).toBeVisible();
  await expect(
    page.getByText("there is no way to reach them yet; the ask is recorded")
  ).toBeVisible();
  await expect(
    page.getByText("no vault has been addressed for it yet")
  ).toBeVisible();
  await expect(page.locator('[data-phrase="unstated"]')).toHaveCount(0);
  await expect(page.locator('[data-reach="live"]')).toBeVisible();
  await expect(page.getByText("Not reached yet")).toHaveCount(0);

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Revoke" }).first().click();
  await expect(page.getByText("Stop sharing with Priya?")).toBeVisible();
  await expect(
    page.getByText("their vault is asked to remove its copy", { exact: false })
  ).toBeVisible();

  const confirm = page.getByRole("button", { name: "Revoke", exact: true });
  await expect(confirm).toHaveClass(/destructive/u);
  await expect(page.locator("button.kit-btn.primary")).toHaveCount(0);

  await confirm.click();
  await expect
    .poll(() => page.evaluate(() => window.__grantStatus))
    .toStrictEqual([
      "no longer shared; a vault holding a copy has been asked to remove it and has not yet confirmed",
    ]);
});
