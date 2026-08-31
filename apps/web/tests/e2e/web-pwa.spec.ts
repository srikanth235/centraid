import { expect, test } from "@playwright/test";

import {
  ADMIN_TOKEN,
  API_URL,
  GATEWAY_ENDPOINT_ID,
  applyConnection,
  mintControlSession,
} from "./connect.js";

test("boots as a PWA and establishes a cookie control session", async ({
  page,
}) => {
  const gatewayResponses: Array<{ url: string; status: number }> = [];
  page.on("response", (response) => {
    if (response.url().startsWith(API_URL)) {
      gatewayResponses.push({ url: response.url(), status: response.status() });
    }
  });
  const vaultId = await mintControlSession(page);
  const controlCookie = (
    await page.context().cookies(`${API_URL}/centraid/_web/control`)
  ).find((cookie) => cookie.name === "__centraid_control");
  expect(controlCookie).toMatchObject({ httpOnly: true, sameSite: "Strict" });

  await applyConnection(page, vaultId);

  await expect(
    page.evaluate(() => window.CentraidApi.getGatewayAuth())
  ).resolves.toMatchObject({
    baseUrl: "http://127.0.0.1:4173",
    gatewayId: GATEWAY_ENDPOINT_ID,
    vaultId,
    iroh: true,
    rememberDevice: true,
  });

  const appsProbe = await page.evaluate(async (apiUrl) => {
    const response = await fetch(
      `${apiUrl}/centraid/_web/control?path=${encodeURIComponent("/centraid/_apps")}`,
      { credentials: "include" }
    );
    return { status: response.status, text: await response.text() };
  }, API_URL);
  expect(appsProbe.status, appsProbe.text).toBe(200);
  // The proxied listing is the gateway's own, not a canned body: every vault
  // mounts the eight bundled system apps, so `tasks` must be in it.
  expect(appsProbe.text).toContain('"tasks"');

  // Home is the content springboard (#708) — custom apps open via the command
  // palette, not a library card on Home.
  await expect(
    page.locator('nav[aria-label="Apps"]').first(),
    JSON.stringify(gatewayResponses, null, 2)
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("centraid.web.v1.connection")
    )
  ).not.toContain(ADMIN_TOKEN);

  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBeTruthy();
  // There is no quick capture on this seat — the assistant is the one place a
  // stray thought goes, so the manifest declares neither a share target nor a
  // capture shortcut and no `?capture=` URL opens anything.
  const manifestBody = (await manifest.json()) as {
    share_target?: unknown;
    shortcuts?: Array<{ name?: string; url?: string }>;
  };
  expect(manifestBody.share_target).toBeUndefined();
  expect(
    (manifestBody.shortcuts ?? []).map((shortcut) => shortcut.name)
  ).not.toContain("Quick capture");
  expect(
    (manifestBody.shortcuts ?? []).some((shortcut) =>
      shortcut.url?.includes("capture")
    )
  ).toBe(false);
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null)
    )
    .toBe(true);
});
