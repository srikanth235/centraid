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

/** Harness entry: the SHIPPED section with a door stubbing delivered vs
 *  parked-awaiting-invitation grants. */
const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { PersonGrants } from ${JSON.stringify(SECTION)};

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
      // NEVER REACHED: this vault has no channel to Priya at all, and the
      // screen still offers sharing — the invitation is the grant's own step.
      channel: null,
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

/** Bundle the shipped section, its CSS modules included, for the browser. */
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
  await expect(page.getByText("Delivered")).toBeVisible();
  await expect(page.getByText("Invitation pending")).toBeVisible();

  // Not reached is an OPPORTUNITY, not an error or a link ceremony.
  await expect(
    page.getByText("Not reached yet · Sharing sends an invitation first.")
  ).toBeVisible();

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
