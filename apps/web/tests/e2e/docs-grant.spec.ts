import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { toCss } from "@centraid/design";

// DOCS ON THE GRANT PLANE, in a real browser (#825): the shipped details rail
// stubbed at `window.centraid.grants` (the one reach-in a web blueprint has).
// Proves the APP: object-first sheet, registry-decided verbs, one status line.

declare global {
  interface Window {
    /** What the harness collected from Docs' one status line. */
    __docsStatus: string[];
  }
}

const here = import.meta.dirname;
const REPO_ROOT = path.resolve(here, "../../../..");
const KIT_CSS = path.join(REPO_ROOT, "packages/design/src/elements/kit.css");
const DETAILS = path.join(
  REPO_ROOT,
  "packages/blueprints/apps/docs/components/Details.tsx"
);
const EVIDENCE_DIR = path.join(REPO_ROOT, "artifacts/e2e/ui-impact");
const EVIDENCE_PNG = "issue-825-docs-grant.png";

/** The shipped rail over a stub bridge answering the declared registry, one
 * standing grant and a create — `webGrantDoor()`'s surface. */
const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Details } from ${JSON.stringify(DETAILS)};

window.__docsStatus = [];
window.centraid = {
  scopes: [{ id: "vault-priya", label: "Library", personal: true, canWrite: true }],
  commonsResidents: () => Promise.resolve([]),
  grants: {
    subjects: () =>
      Promise.resolve({
        subjects: [
          { subjectType: "core.document", capabilities: ["view", "edit"] },
          { subjectType: "docs.folder", capabilities: ["view", "edit"] },
        ],
      }),
    forParty: () => Promise.resolve({ channel: { state: "live" }, grants: [] }),
    forAudience: () => Promise.resolve({ grants: [] }),
    forSubject: () =>
      Promise.resolve({
        grants: [
          {
            grantId: "grant-1",
            audience: { kind: "party", id: "party-ravi" },
            subjectType: "core.document",
            subjectId: "doc-1",
            capability: "view",
            grantedAt: "2026-08-01T10:00:00.000Z",
            revokedAt: null,
            grantedBy: "party-owner",
            maxSizeBytes: null,
            fulfillment: [
              { peerVaultId: "vault-ravi", state: "delivered", updatedAt: "", detail: null },
            ],
          },
        ],
      }),
    create: () => Promise.resolve({ outcome: "created" }),
    revoke: () =>
      Promise.resolve({
        message:
          "no longer shared; a vault holding a copy has been asked to remove it and has not yet confirmed",
      }),
  },
};

const doc = {
  document_id: "doc-1",
  content_id: "content-1",
  title: "Trip plan",
  media_type: "text/plain",
  byte_size: 4096,
  poster_uri: null,
  created_at: "2026-07-01T10:00:00.000Z",
  updated_at: "2026-08-01T10:00:00.000Z",
  folder_id: "folder-1",
  starred: false,
  trashed: false,
  purge_at: null,
  tags: [],
  custody_state: null,
  shared_with: [],
};

createRoot(document.getElementById("root")).render(
  createElement(Details, {
    doc,
    docked: true,
    folderName: () => "Trip",
    onClose: () => undefined,
    onOpenQuick: () => undefined,
    onToggleStar: () => undefined,
    onMove: () => undefined,
    onTrash: () => undefined,
    onRestore: () => undefined,
    onReplace: () => undefined,
    loadHistory: () => Promise.resolve({ versions: [] }),
    onOpenVersions: () => undefined,
    onAddTag: () => undefined,
    onRemoveTag: () => undefined,
    shareHost: {
      audiences: [
        { kind: "party", id: "party-ravi", label: "Ravi" },
        { kind: "circle", id: "circle-1", label: "Ski trip" },
      ],
      onStatus: (message) => window.__docsStatus.push(message),
    },
  })
);
`;

/** Bundle the shipped rail, its CSS modules included, for the browser. */
async function bundleRail(): Promise<{ js: string; css: string }> {
  const result = await build({
    stdin: {
      contents: ENTRY,
      resolveDir: here,
      loader: "tsx",
      sourcefile: "docs-grant-harness.tsx",
    },
    bundle: true,
    write: false,
    // Never written (`write: false`); needed to name the CSS output.
    outdir: path.join(here, ".docs-grant-bundle"),
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

test("Docs shares a document through the one shared grant kit", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const [{ js, css }, kitCss] = await Promise.all([
    bundleRail(),
    readFile(KIT_CSS, "utf8"),
  ]);

  await page.setViewportSize({ width: 1000, height: 1000 });
  await page.setContent(
    `<style>${toCss()}</style><style>${kitCss}</style><style>${css}</style>` +
      `<body style="background:var(--bg);color:var(--text);margin:0">` +
      `<div id="root" class="centraid-inline-scope"></div></body>`
  );
  await page.addScriptTag({ content: js });

  // The rail's own verb.
  const share = page.getByRole("button", { name: "Share document" });
  await expect(share).toBeVisible();
  await share.click();

  const dialog = page.locator("dialog.kit-modal-back");
  await expect(dialog).toBeVisible();

  // OBJECT-FIRST: the document is a fixed line; the sheet asks only who.
  await expect(dialog.getByText("Trip plan")).toBeVisible();
  await expect(dialog.getByLabel("What to share")).toHaveCount(0);

  // The REGISTRY decides the verbs — Docs hardcodes none of them.
  await expect(dialog.getByRole("button", { name: "Can edit" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Can view" })).toBeVisible();

  await expect(dialog.getByText("Delivered")).toBeVisible();

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
    fullPage: true,
  });

  await dialog.getByRole("button", { name: "Share", exact: true }).click();

  // The outcome leaves through the APP's single status line.
  await expect
    .poll(() => page.evaluate(() => window.__docsStatus))
    .toStrictEqual(["Ravi can see it"]);
});
