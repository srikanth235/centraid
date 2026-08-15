import { expect, test } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";

test("boots as a PWA and establishes a cookie control session", async ({
  page,
}) => {
  const gatewayResponses: Array<{ url: string; status: number }> = [];
  page.on("response", (response) => {
    if (response.url().startsWith(API_URL)) {
      gatewayResponses.push({ url: response.url(), status: response.status() });
    }
  });
  await installHarnessControlTransport(page, API_URL);
  await page.goto("/");

  const control = await page.evaluate(
    async ({ apiUrl, token }) => {
      const response = await fetch(`${apiUrl}/centraid/_web/control`, {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: await response.json() };
    },
    { apiUrl: API_URL, token: ADMIN_TOKEN }
  );
  expect(control.status).toBe(200);
  const vaultId = (control.body as { vaultId: string }).vaultId;
  const controlCookie = (
    await page.context().cookies(`${API_URL}/centraid/_web/control`)
  ).find((cookie) => cookie.name === "__centraid_control");
  expect(controlCookie).toMatchObject({ httpOnly: true, sameSite: "Strict" });

  await page.evaluate(
    ({ endpointId, endpointTicket, vault }) => {
      sessionStorage.removeItem("centraid.web.v1.connection");
      localStorage.setItem(
        "centraid.web.v1.connection",
        JSON.stringify({
          endpointId,
          endpointTicket,
          label: "Browser E2E",
          displayName: "Web owner",
          avatarColor: "#6f5bf6",
          vaultId: vault,
          rememberDevice: true,
        })
      );
      localStorage.setItem(
        "centraid.web.v1.settings",
        JSON.stringify({ onboardingCompletedAt: new Date().toISOString() })
      );
    },
    {
      endpointId: GATEWAY_ENDPOINT_ID,
      endpointTicket: GATEWAY_ENDPOINT_TICKET,
      vault: vaultId,
    }
  );
  await page.reload();

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
  await expect(manifest.json()).resolves.toMatchObject({
    share_target: {
      action: "/?capture=shared",
      method: "GET",
      params: { text: "text", title: "title", url: "url" },
    },
    shortcuts: expect.arrayContaining([
      expect.objectContaining({
        name: "Quick capture",
        url: "/?capture=shortcut",
      }),
    ]),
  });
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null)
    )
    .toBe(true);
});
