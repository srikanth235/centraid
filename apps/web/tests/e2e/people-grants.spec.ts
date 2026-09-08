import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { toCss } from "@centraid/design";

// PEOPLE'S PERSON SCREEN AS THE GRANT DASHBOARD, in a real browser (#825):
// shipped section, grant plane stubbed at its `door` seam. A browser proves
// what jsdom cannot: recipes paint, "not reached" reads as an opportunity,
// Share on a never-reached person is ONE GESTURE, no link ceremony.

declare global {
  interface Window {
    /** What the harness collected from the section's one feedback channel. */
    __peopleStatus: string[];
  }
}

const here = import.meta.dirname;
const REPO_ROOT = path.resolve(here, "../../../..");
const KIT_CSS = path.join(REPO_ROOT, "packages/design/src/elements/kit.css");
const SECTION = path.join(
  REPO_ROOT,
  "packages/blueprints/apps/people/components/PersonGrants.tsx"
);
const EVIDENCE_DIR = path.join(REPO_ROOT, "artifacts/e2e/ui-impact");
const EVIDENCE_PNG = "issue-825-people-grants.png";

/** Harness entry: the SHIPPED section, with a door stubbing delivered vs
 *  parked grants. */
const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { PersonGrants } from ${JSON.stringify(SECTION)};

// Phrase and reason come from the WIRE, never worked out on this side (ruling
// V-phrases) — so the stub carries what grantPhrase() yields for these rows:
// one delivered row is "shared", an awaiting_channel row is "on its way", and
// no rows at all is "on its way" for a different reason.
const standing = (state) => {
  if (!state)
    return {
      phrase: "on its way",
      reason: "no vault has been addressed for it yet",
    };
  if (state === "delivered")
    return {
      phrase: "shared",
      reason: "the vault it addresses is holding it",
    };
  return {
    phrase: "on its way",
    reason: "there is no way to reach them yet; the ask is recorded",
  };
};

const grant = (id, subjectType, state) => ({
  grantId: id,
  audience: { kind: "party", id: "party-priya" },
  subjectType,
  subjectId: id,
  capability: "view",
  grantedAt: "2026-08-01T10:00:00.000Z",
  revokedAt: null,
  grantedBy: "party-owner",
  maxSizeBytes: null,
  ...standing(state),
  fulfillment: state
    ? [{ peerVaultId: "vault-priya", state, updatedAt: "", detail: null }]
    : [],
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
      // LINKED. #825 had this never-reached, sharing sending the invitation
      // itself; #903's G-channel superseded that, so the gesture below is
      // only testable over a live binding (#905).
      channel: { state: "live", vaultId: "vault-priya" },
      grants: [
        grant("doc-1", "core.document", "delivered"),
        grant("photo-1", "media.asset", "awaiting_channel"),
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

window.__peopleStatus = [];

createRoot(document.getElementById("root")).render(
  createElement(PersonGrants, {
    partyId: "party-priya",
    personName: "Priya",
    roster: [
      { party_id: "party-priya", name: "Priya" },
      { party_id: "party-ravi", name: "Ravi" },
    ],
    open: true,
    onToggle: () => undefined,
    onStatus: (message) => window.__peopleStatus.push(message),
    door,
    available: true,
  })
);
`;

/** Bundle the shipped section, CSS modules included, for the browser. */
async function bundleSection(): Promise<{ js: string; css: string }> {
  const result = await build({
    stdin: {
      contents: ENTRY,
      resolveDir: here,
      loader: "tsx",
      sourcefile: "people-grants-harness.tsx",
    },
    bundle: true,
    write: false,
    // Never written (`write: false`); esbuild needs a path to name the CSS
    // output against.
    outdir: path.join(here, ".people-grants-bundle"),
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

test("the person screen lists live grants and shares in one gesture", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const [{ js, css }, kitCss] = await Promise.all([
    bundleSection(),
    readFile(KIT_CSS, "utf8"),
  ]);

  await page.setViewportSize({ width: 900, height: 900 });
  await page.setContent(
    `<style>${toCss()}</style><style>${kitCss}</style><style>${css}</style>` +
      `<body style="background:var(--bg);color:var(--text);margin:0">` +
      `<div id="root" class="centraid-inline-scope"></div></body>`
  );
  await page.addScriptTag({ content: js });

  await expect(page.getByText("Shared with them")).toBeVisible();
  // Each row wears the vault's own phrase: the delivered document is settled,
  // the photo parked for want of a channel is travelling.
  await expect(page.getByText("Shared", { exact: true })).toBeVisible();
  await expect(page.getByText("On its way", { exact: true })).toBeVisible();

  // A live link needs no note: nothing for the member to do first (#903).
  await expect(page.getByText("Reachable", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Link their account in People to share with them.")
  ).toBeHidden();

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
    fullPage: true,
  });

  // ONE GESTURE: Share opens the sheet already on this person.
  await page
    .getByRole("button", { name: "Share", exact: true })
    .first()
    .click();
  await expect(page.locator("dialog.kit-modal-back")).toBeVisible();
  await page
    .locator("dialog.kit-modal-back")
    .getByRole("button", { name: "Share", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__peopleStatus))
    .toStrictEqual(["Priya can see it"]);

  // Revoke asks first, then reports the route's own derived sentence verbatim.
  await page.getByRole("button", { name: "Revoke document" }).click();
  await expect(page.getByText("Stop sharing with Priya?")).toBeVisible();
  await expect(
    page.getByText("their vault is asked to remove its copy", { exact: false })
  ).toBeVisible();
  await page
    .locator("dialog")
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__peopleStatus))
    .toStrictEqual([
      "Priya can see it",
      "no longer shared; a vault holding a copy has been asked to remove it and has not yet confirmed",
    ]);
});
