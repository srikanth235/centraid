import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  cleanupEnv,
  clearFirstRunSample,
  closeApp,
  launchApp,
  makeEnv,
  openAppFromPalette,
  waitForHome,
} from "./fixtures";
import type { TestEnv } from "./fixtures";

const PHOTO_NAME = "harbour-at-dusk.png";
const PHOTO_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAHklEQVR42mM4YaOhUXHiwx0bOTk5BjgLKMoAZwFFASxyDuPOcNAmAAAAAElFTkSuQmCC";
const PHOTO_BYTES = Buffer.from(PHOTO_BASE64, "base64");
const PHOTO_SHA = createHash("sha256").update(PHOTO_BYTES).digest("hex");

interface LibraryAsset {
  asset_id: string;
  title?: string | null;
  content_uri?: string | null;
  byte_size?: number | null;
  favorite?: number | null;
}

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
  await clearFirstRunSample(page);
}

async function localCasBytes(
  env: TestEnv,
  sha: string
): Promise<Buffer | null> {
  const suffix = path.join("blobs", "sha256", sha.slice(0, 2), sha);
  const entries = await readdir(env.workspace, { recursive: true }).catch(
    () => [] as string[]
  );
  const hit = entries.find((entry) => entry.endsWith(suffix));
  return hit ? readFile(path.join(env.workspace, hit)) : null;
}

test("Photos imports a real photograph and its bytes stay on this machine", async () => {
  test.setTimeout(300_000);
  const env = await makeEnv();
  const { app, page } = await launchApp(env);
  try {
    await foundDesktop(page);
    await openFirstParty(page, "Photos");

    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            try {
              const outcome = await window.centraid.write({
                action: "update-asset",
                input: {
                  asset_id: "asset-e2e-readiness-probe",
                  title: "readiness-probe",
                },
                intentId: "photos-e2e-readiness-probe",
              });
              return outcome.status;
            } catch {
              return "replica-not-ready";
            }
          }),
        { timeout: 60_000 }
      )
      .not.toBe("replica-not-ready");

    await page
      .getByTestId("inline-app-view")
      .locator("#fileInput")
      .setInputFiles({
        name: PHOTO_NAME,
        mimeType: "image/png",
        buffer: PHOTO_BYTES,
      });

    const tile = page
      .getByRole("button", { name: PHOTO_NAME, exact: true })
      .first();
    await expect(tile).toBeVisible({ timeout: 30_000 });

    await expect(page.locator(".kit-pending-chip")).toHaveCount(0);

    await expect
      .poll(async () => (await localCasBytes(env, PHOTO_SHA))?.length ?? 0, {
        timeout: 30_000,
      })
      .toBe(PHOTO_BYTES.length);
    const onDisk = await localCasBytes(env, PHOTO_SHA);
    expect(onDisk?.toString("base64")).toBe(PHOTO_BASE64);

    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Photos");
    await expect(
      page.getByRole("button", { name: PHOTO_NAME, exact: true }).first()
    ).toBeVisible({ timeout: 30_000 });

    const library = await page.evaluate(() =>
      window.centraid.read<{ assets: LibraryAsset[] }>({
        query: "library",
        input: {},
      })
    );
    const imported = library.assets.filter(
      (asset: LibraryAsset) => asset.title === PHOTO_NAME
    );
    expect(imported).toHaveLength(1);
    expect(imported[0]!.byte_size).toBe(PHOTO_BYTES.length);
    const contentUri = imported[0]!.content_uri;
    expect(contentUri).toEqual(expect.any(String));

    const roundTrip = await page.evaluate(async (uri) => {
      const toBase64 = (bytes: Uint8Array): string => {
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      };
      if (uri.startsWith("data:")) {
        const comma = uri.indexOf(",");
        const meta = uri.slice(0, comma);
        const payload = uri.slice(comma + 1);
        return meta.includes("base64")
          ? payload
          : toBase64(new TextEncoder().encode(decodeURIComponent(payload)));
      }
      const { baseUrl, token } = await window.CentraidApi.getGatewayAuth();
      const response = await fetch(new URL(uri, baseUrl).toString(), {
        headers: { authorization: `Bearer ${token}` },
      });
      return toBase64(new Uint8Array(await response.arrayBuffer()));
    }, contentUri!);
    expect(roundTrip).toBe(PHOTO_BASE64);

    const favorited = await page.evaluate(
      async (assetId) =>
        window.centraid.write({
          action: "update-asset",
          input: { asset_id: assetId, favorite: 1 },
          intentId: "photos-e2e-favorite",
        }),
      imported[0]!.asset_id
    );
    expect(favorited.status).toBe("executed");

    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Photos");
    const afterStar = await page.evaluate(() =>
      window.centraid.read<{ assets: LibraryAsset[] }>({
        query: "library",
        input: {},
      })
    );
    const starred = afterStar.assets.find(
      (asset: LibraryAsset) => asset.asset_id === imported[0]!.asset_id
    );
    expect(starred?.favorite).toBe(1);

    const evidenceDir = path.join(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "issue-864-photos-custodian.png"),
      fullPage: true,
    });
    await page.screenshot({
      path: path.join(evidenceDir, "issue-916-photos-star.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
    await cleanupEnv(env);
  }
});
