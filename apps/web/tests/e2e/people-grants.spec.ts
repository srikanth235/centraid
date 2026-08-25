import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { toCss } from "@centraid/design";

// PEOPLE'S PERSON SCREEN AS THE GRANT DASHBOARD, in a real browser (#825).
//
// The shipped section is mounted over the shipped design tokens and the
// shipped `kit.css`, with the grant plane stubbed at the ONE seam it was built
// to take: its `door`. Nothing is reimplemented here.
//
// What a browser proves that a jsdom suite cannot: the section, its rows and
// the destructive confirm paint at the app's own recipes, the reach line reads
// as an invitation opportunity rather than an error, and `Share` on a person
// this vault has NEVER REACHED is one gesture — no link ceremony is drawn
// anywhere in the flow, which is the acceptance item this spec settles.
//
// The capture is the People UI-impact evidence (#825).

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

/**
 * The harness entry. It imports the SHIPPED section and hands it a door whose
 * answers cover the two states this screen has to tell apart on one person: a
 * grant already delivered, and one still parked waiting for the invitation the
 * grant itself minted.
 */
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
    // Never written (`write: false`), but esbuild needs a path to name the CSS
    // module output against — the class map and the stylesheet are two halves
    // of one build.
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

  // Every live grant reaching this party, each with its own delivery state.
  await expect(page.getByText("Shared with them")).toBeVisible();
  await expect(page.getByText("Delivered")).toBeVisible();
  await expect(page.getByText("Invitation pending")).toBeVisible();

  // Never reached is an OPPORTUNITY, in the kit's words — not an error, and
  // not a link ceremony standing in the way.
  await expect(
    page.getByText("Not reached yet · Sharing sends an invitation first.")
  ).toBeVisible();

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
    fullPage: true,
  });

  // ONE GESTURE: Share opens the sheet already on this person, and its own
  // Share sends the grant. Nothing between the two asks for a link first.
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

  // Revoking asks first, in the honest best-effort words, and then reports the
  // route's own derived sentence verbatim.
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
