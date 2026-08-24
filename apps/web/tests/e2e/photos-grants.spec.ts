import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { build } from "esbuild";

import { toCss } from "@centraid/design";

// PHOTOS ON THE GRANT PLANE, in a real browser (#825).
//
// This proves the APP, not the kit: the shipped album
// bar (`apps/photos/components/AlbumBar.tsx`) is mounted whole, over the
// shipped tokens and `kit.css`, with nothing stubbed below the two seams the
// app genuinely owns — the host bridge (`window.centraid`) and the frame's one
// status line (`setStatusSink`). Everything between the member's press and the
// grant is the shipped code path: Photos' roster mapping, the object-first
// entry, the kit's registry read, the create call.
//
// What a browser proves that a jsdom suite cannot: Share is on the album bar
// where a member would look for it, the sheet opens over THIS album with its
// own title as the fixed subject, the capability picker draws only what the
// gateway's registry answers for `core.collection` (view — never edit, which
// is why album co-contribution is a deferred v1 non-goal and not a hidden
// button), and the outcome lands on the app's status line rather than a toast.
//
// The capture is the Photos UI-impact evidence (#825).

declare global {
  interface Window {
    /** What the app's ONE status line was asked to say. */
    __photosStatus: string[];
    /** Every grant request the host bridge was handed. */
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
 * The harness entry. It imports the SHIPPED album bar and the SHIPPED status
 * sink, and stubs only the host bridge — the roster Photos reads for its
 * audiences, and the grant plane the kit writes through. The registry answers
 * `view` alone for `core.collection`, which is what the gateway declares.
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
    forParty: () => Promise.resolve({ channel: null, grants: [] }),
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
    // Never written (`write: false`), but esbuild needs a path to name the
    // CSS-module output against — the class map and the stylesheet are two
    // halves of one build.
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

  // The way in is on the album's own bar, beside Rename and Delete.
  const share = page.getByRole("button", { name: "Share", exact: true });
  await expect(share).toBeVisible();
  await share.click();

  const dialog = page.locator("dialog.kit-modal-back");
  await expect(dialog).toBeVisible();

  // OBJECT-FIRST: the album is the fixed "what", by its own title.
  await expect(page.getByText("Cornwall 2024", { exact: true })).toBeVisible();
  // The roster Photos supplied — a person, and a named circle beside them.
  const audience = page.getByRole("combobox", { name: "Person or circle" });
  await expect(audience).toHaveValue("party-priya");
  await expect(
    audience.locator("option", { hasText: "Named group · Ski trip" })
  ).toHaveCount(1);

  // THE REGISTRY DECIDES THE VERBS. An album answers `view` and nothing else,
  // so no edit control is drawn — album co-contribution is a v1 non-goal, and
  // this is what that looks like rather than a button that would be refused.
  await expect(page.getByRole("button", { name: "Can view" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Can edit" })).toHaveCount(0);
  // Absent is never empty: nothing standing says so in the album's own words.
  await expect(
    page.getByText("Nothing shared with Cornwall 2024 yet.")
  ).toBeVisible();

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
    fullPage: true,
  });

  await page.locator("button.kit-btn.primary").click();

  // The grant names the album as `core.collection`, with its title carried so
  // the receiving side has a name and not an id.
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
  // The outcome reaches the FRAME's one status line, never a toast.
  await expect
    .poll(() => page.evaluate(() => window.__photosStatus))
    .toStrictEqual(["Priya can see it"]);
});
