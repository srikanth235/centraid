import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { toCss } from "@centraid/design";

// PHOTOS ON THE GRANT PLANE, in a real browser (#825). Proves the APP, not the
// kit: shipped album bar over shipped tokens, stubbed only at the host bridge
// and status line. This is the #825 UI-impact capture.

declare global {
  interface Window {
    __photosStatus: string[];
    /** Grant requests handed to the host bridge. */
    __photosGrants: unknown[];
  }
}

const here = import.meta.dirname;
const REPO_ROOT = path.resolve(here, "../../../..");
const KIT_CSS = path.join(REPO_ROOT, "packages/design/src/elements/kit.css");
const ALBUM_BAR = path.join(
  REPO_ROOT,
  "packages/blueprints/apps/photos/components/AlbumBar.tsx"
);
const OUTCOMES = path.join(
  REPO_ROOT,
  "packages/blueprints/apps/photos/outcomes.ts"
);
const EVIDENCE_DIR = path.join(REPO_ROOT, "artifacts/e2e/ui-impact");
const EVIDENCE_PNG = "issue-825-photos-album-grant.png";

/**
 * Harness entry: SHIPPED album bar + status sink; stubs only the host bridge
 * (registry answers `view` alone for `core.collection`).
 */
const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AlbumBar } from ${JSON.stringify(ALBUM_BAR)};
import { setStatusSink } from ${JSON.stringify(OUTCOMES)};

window.__photosStatus = [];
window.__photosGrants = [];

window.centraid = {
  scopes: [{ id: "", label: "Library", personal: true, canWrite: true }],
  shareTargets: () =>
    Promise.resolve([
      { partyId: "party-priya", label: "Priya", vaultId: "vault-priya" },
      { partyId: "party-ravi", label: "Ravi" },
    ]),
  shareCircles: () =>
    Promise.resolve([
      { circleId: "circle-1", label: "Ski trip", members: [] },
    ]),
  grants: {
    subjects: () =>
      Promise.resolve({
        subjects: [
          { subjectType: "core.collection", capabilities: ["view"] },
          { subjectType: "media.asset", capabilities: ["view"] },
          { subjectType: "core.document", capabilities: ["view", "edit"] },
        ],
      }),
    // Priya is LINKED. Since #903 a live \`share_party_vault_binding\` is the
    // prerequisite for a party grant, so a null channel would leave the
    // sheet's Share correctly inert and this claim untestable (#905).
    forParty: () =>
      Promise.resolve({
        known: true,
        channel: { state: "live", vaultId: "vault-priya" },
        grants: [],
      }),
    forAudience: () => Promise.resolve({ grants: [] }),
    forSubject: () => Promise.resolve({ grants: [] }),
    create: (request) => {
      window.__photosGrants.push(request);
      return Promise.resolve({ outcome: "created" });
    },
    revoke: () => Promise.resolve({ message: "no longer shared" }),
  },
};

setStatusSink((note) => {
  window.__photosStatus.push(note ? note.text : "");
});

createRoot(document.getElementById("root")).render(
  createElement(AlbumBar, {
    albumId: "alb-cornwall",
    title: "Cornwall 2024",
    renaming: false,
    canWrite: true,
    onBack: () => undefined,
    onStartRename: () => undefined,
    onRenameSubmit: () => undefined,
    onRenameCancel: () => undefined,
    onDelete: () => undefined,
  })
);
`;

/** Bundle the shipped bar, its CSS modules included, for the browser. */
async function bundleBar(): Promise<{ js: string; css: string }> {
  const result = await build({
    stdin: {
      contents: ENTRY,
      resolveDir: here,
      loader: "tsx",
      sourcefile: "photos-grants-harness.tsx",
    },
    bundle: true,
    write: false,
    // Not written (`write: false`); esbuild needs it to name CSS-module output.
    outdir: path.join(here, ".photos-grants-bundle"),
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

test("an album shares through the one grant kit, view only", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const [{ js, css }, kitCss] = await Promise.all([
    bundleBar(),
    readFile(KIT_CSS, "utf8"),
  ]);

  await page.setViewportSize({ width: 900, height: 900 });
  await page.setContent(
    `<style>${toCss()}</style><style>${kitCss}</style><style>${css}</style>` +
      `<body style="background:var(--bg);color:var(--text);margin:0">` +
      `<div id="root" class="centraid-inline-scope"></div></body>`
  );
  await page.addScriptTag({ content: js });

  const share = page.getByRole("button", { name: "Share", exact: true });
  await expect(share).toBeVisible();
  await share.click();

  const dialog = page.locator("dialog.kit-modal-back");
  await expect(dialog).toBeVisible();

  // OBJECT-FIRST: the album is the fixed subject; Photos' roster beside it.
  await expect(page.getByText("Cornwall 2024", { exact: true })).toBeVisible();
  const audience = page.getByRole("combobox", { name: "Person or circle" });
  await expect(audience).toHaveValue("party-priya");
  await expect(
    audience.locator("option", { hasText: "Named group · Ski trip" })
  ).toHaveCount(1);

  // Registry decides verbs: view only — no edit control drawn.
  await expect(page.getByRole("button", { name: "Can view" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Can edit" })).toHaveCount(0);
  // Absent ≠ empty: nothing shared says so in the album's own words.
  await expect(
    page.getByText("Cornwall 2024 is not shared with anyone yet.")
  ).toBeVisible();

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
    fullPage: true,
  });

  await page.locator("button.kit-btn.primary").click();

  // Grant names the album with its title carried, not just an id.
  await expect
    .poll(() => page.evaluate(() => window.__photosGrants))
    .toStrictEqual([
      {
        audienceKind: "party",
        audienceId: "party-priya",
        subjectType: "core.collection",
        subjectId: "alb-cornwall",
        capability: "view",
        subjectLabel: "Cornwall 2024",
      },
    ]);
  // Outcome reaches the frame's one status line, never a toast.
  await expect
    .poll(() => page.evaluate(() => window.__photosStatus))
    .toStrictEqual(["Priya can see it"]);
});
