import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  cleanupEnv,
  closeApp,
  launchApp,
  makeEnv,
  openAppFromPalette,
  waitForHome,
} from "./fixtures";

// Desktop offline honesty (matrix cell `desktop.offline`): a write made with
// the renderer's network severed lands in the durable replica outbox, paints
// its row as pending in the production app, and BOTH survive a full Electron
// reload while still offline.
//
// It drove Tally, Tasks and Agenda until those three interfaces were removed
// pending a ground-up redesign, and is rebuilt here on Docs — the remaining
// app whose production rows render the shared pending overlay
// (`apps/docs/components/List.tsx` → `_shared/PendingWriteActions.tsx`). The
// contract asserted is unchanged and app-agnostic: replica ⊕ outbox recovery
// across a reload, with the pending state visible to the member the whole
// time. Nothing here is mocked; the local gateway is the real one.
//
// The offline write is issued through `window.centraid.write` rather than a
// toolbar control ON PURPOSE. Docs' only rename affordances live in the
// sidebar the inline seat hides and behind the Quick Look info panel, so a
// UI-driven rename would spend most of this journey proving navigation. The
// door used is the same one the app's own handler calls, and every observable
// after it — the optimistic title, the pending chip, their survival across the
// reload — is the production UI's.

const DOC_TITLE = "quarterly-review.txt";
const DOC_BODY = "Numbers for the quarterly review.";
const RENAMED_TITLE = "quarterly-review-offline.txt";
const RENAME_INTENT = "desktop-pending-overlay-offline-rename";

async function openFirstParty(page: Page, name: string): Promise<void> {
  await openAppFromPalette(page, name);
  await expect(page.getByTestId("inline-app-view")).toBeVisible();
  await expect(page.getByText(`Loading ${name}…`, { exact: true })).toHaveCount(
    0
  );
  await expect
    .poll(() => page.evaluate(() => Boolean(window.centraid)))
    .toBe(true);
}

async function foundDesktop(page: Page): Promise<void> {
  await page
    .getByTestId("first-run-choice")
    .getByRole("button", { name: /start fresh on this mac/iu })
    .click();
  // First run is one connection act: the local path starts the embedded host
  // and hands straight to Home. Profile identity belongs in Settings, so this
  // fixture must not resurrect the deleted name/color gate.
  const onboarding = page.getByTestId("onboarding-view");
  await onboarding.waitFor({ state: "visible", timeout: 60_000 });
  await onboarding.waitFor({ state: "detached", timeout: 60_000 });
  await waitForHome(page);
}

/** The document ids the drive read carries for a given exact title. */
async function driveIdsFor(page: Page, title: string): Promise<string[]> {
  type Drive = { documents: Array<{ document_id: string; title: string }> };
  const drive = await page.evaluate(() =>
    window.centraid.read<Drive>({ query: "drive", input: {} })
  );
  return drive.documents
    .filter((doc) => doc.title === title)
    .map((doc) => doc.document_id);
}

test("a production Docs row queued offline survives an Electron reload", async () => {
  test.setTimeout(180_000);
  const env = await makeEnv();
  const { app, page } = await launchApp(env);
  try {
    await foundDesktop(page);
    await openFirstParty(page, "Docs");

    // Write-rail readiness must be proven BEFORE severing the network: the
    // replica session bootstraps asynchronously, an offline session can never
    // finish bootstrapping, and a write issued before it does throws
    // not-bootstrapped instead of queueing. The probe is a write the vault
    // deterministically REFUSES (an unstaged sha fails add_document's
    // staged_or_owned precondition), so readiness costs no row.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            try {
              const outcome = await window.centraid.write({
                action: "upload",
                input: {
                  staged_sha: "0".repeat(64),
                  title: "readiness-probe",
                },
                intentId: "desktop-pending-overlay-readiness-probe",
              });
              return outcome.status;
            } catch {
              return "replica-not-ready";
            }
          }),
        { timeout: 30_000 }
      )
      .not.toBe("replica-not-ready");

    // One real document, through the product's own upload control, while the
    // gateway is still reachable — this is the canonical row the offline write
    // then decorates.
    await page.locator('input[aria-label="Upload files"]').setInputFiles({
      name: DOC_TITLE,
      mimeType: "text/plain",
      buffer: Buffer.from(DOC_BODY, "utf8"),
    });
    await expect(
      page.getByRole("button", { name: `Select ${DOC_TITLE}` })
    ).toBeVisible({ timeout: 30_000 });
    let documentId = "";
    await expect
      .poll(
        async () => {
          const ids = await driveIdsFor(page, DOC_TITLE);
          documentId = ids[0] ?? "";
          return ids.length;
        },
        { timeout: 30_000 }
      )
      .toBe(1);

    // Sever the renderer's network and rename the document. Stay on the
    // session the readiness probe proved: remounting the route would start a
    // replica walk that an offline session can never finish, and the write
    // would then throw instead of queueing.
    await page.context().setOffline(true);
    await page.evaluate(
      async ({ id, title, intentId }) =>
        window.centraid.write({
          action: "rename",
          input: { document_id: id, title },
          intentId,
        }),
      { id: documentId, title: RENAMED_TITLE, intentId: RENAME_INTENT }
    );

    // The overlay is the member's answer, painted by the production row: the
    // new title stands where the old one was, and the row says it has not
    // landed yet.
    await expect(
      page.getByRole("button", { name: `Select ${RENAMED_TITLE}` })
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".kit-pending-chip").first()).toHaveText(
      "queued"
    );

    // Durability is the whole claim: a full Electron reload, still offline,
    // must restore BOTH the optimistic row and its pending state from the
    // local outbox rather than snapping back to the canonical title.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Docs");
    await expect(
      page.getByRole("button", { name: `Select ${RENAMED_TITLE}` })
    ).toBeVisible({ timeout: 30_000 });
    // Either honest word for "still in the outbox": `queued` while the drain
    // has not tried, `pending` once it has and is waiting on a connection.
    // What must never appear is a settled row or a denial — the vault has not
    // been reachable since the write.
    await expect(page.locator(".kit-pending-chip").first()).toHaveText(
      /^(?:queued|pending)$/u
    );

    // One row, not two: the outbox entry DECORATES the canonical document it
    // names — an overlay that minted a second row would show the member two
    // copies of one file the moment they went offline.
    expect(await driveIdsFor(page, RENAMED_TITLE)).toEqual([documentId]);
    expect(await driveIdsFor(page, DOC_TITLE)).toEqual([]);

    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "desktop-pending-overlay.png"),
      fullPage: true,
    });
  } finally {
    await page
      .context()
      .setOffline(false)
      .catch(() => undefined);
    await closeApp(app);
    await cleanupEnv(env);
  }
});
