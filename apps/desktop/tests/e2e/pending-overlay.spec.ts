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
  const onboarding = page.getByTestId("onboarding-view");
  await onboarding.waitFor({ state: "visible", timeout: 60_000 });
  await onboarding.waitFor({ state: "detached", timeout: 60_000 });
  await waitForHome(page);
}

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

    await expect(
      page.getByRole("button", { name: `Select ${RENAMED_TITLE}` })
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".kit-pending-chip").first()).toHaveText(
      "queued"
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Docs");
    await expect(
      page.getByRole("button", { name: `Select ${RENAMED_TITLE}` })
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".kit-pending-chip").first()).toHaveText(
      /^(?:queued|pending)$/u
    );

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
