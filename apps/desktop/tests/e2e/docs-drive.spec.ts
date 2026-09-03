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

const DOC_TITLE = "lease-notes.txt";
const DOC_BODY =
  "Lease renewal notes: the deposit clause moved to §4.\n\nKeep the signed copy with the 2026 tax folder.";

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
  await onboarding.waitFor({ state: "visible" });
  await expect(page.getByRole("textbox", { name: "Your name" })).toHaveCount(0);
  await onboarding.waitFor({ state: "detached", timeout: 60_000 });
  await waitForHome(page);
}

test("Docs uploads a real file and its bytes survive an Electron reload", async () => {
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
                intentId: "docs-e2e-readiness-probe",
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

    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Docs");
    await expect(
      page.getByRole("button", { name: `Select ${DOC_TITLE}` })
    ).toBeVisible({ timeout: 30_000 });

    type DriveDoc = {
      title: string;
      content_uri?: string | null;
      byte_size?: number | null;
    };
    const drive = await page.evaluate(() =>
      window.centraid.read<{ documents: DriveDoc[] }>({
        query: "drive",
        input: {},
      })
    );
    const uploaded = drive.documents.filter(
      (d: DriveDoc) => d.title === DOC_TITLE
    );
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.byte_size).toBe(Buffer.byteLength(DOC_BODY, "utf8"));
    const contentUri = uploaded[0]!.content_uri;
    expect(contentUri).toEqual(expect.any(String));
    const roundTrip = await page.evaluate(async (uri) => {
      if (uri.startsWith("data:")) {
        const comma = uri.indexOf(",");
        const meta = uri.slice(0, comma);
        const payload = uri.slice(comma + 1);
        return meta.includes("base64")
          ? atob(payload)
          : decodeURIComponent(payload);
      }
      const { baseUrl, token } = await window.CentraidApi.getGatewayAuth();
      const response = await fetch(new URL(uri, baseUrl).toString(), {
        headers: { authorization: `Bearer ${token}` },
      });
      return response.text();
    }, contentUri!);
    expect(roundTrip).toBe(DOC_BODY);

    await page
      .getByRole("button", { name: `Preview ${DOC_TITLE}` })
      .first()
      .click();
    const reading = page.getByRole("article", { name: DOC_TITLE });
    await expect(reading).toBeVisible({ timeout: 30_000 });
    await expect(
      reading.getByRole("heading", { name: DOC_TITLE })
    ).toBeVisible();
    await expect(reading.getByText(DOC_BODY.split("\n\n")[0]!)).toBeVisible();
    await expect(reading.getByText(DOC_BODY.split("\n\n")[1]!)).toBeVisible();
    const evidenceDir = path.join(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "issue-819-docs-drive.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
    await cleanupEnv(env);
  }
});
