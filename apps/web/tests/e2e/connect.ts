import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";

export const API_URL = "http://127.0.0.1:48765";
export const ADMIN_TOKEN = "centraid-web-e2e-token";
export const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
export const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";

export async function mintControlSession(page: Page): Promise<string> {
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
  return (control.body as { vaultId: string }).vaultId;
}

export async function applyConnection(
  page: Page,
  vaultId: string
): Promise<void> {
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
}

export async function connectPwa(page: Page): Promise<string> {
  const vaultId = await mintControlSession(page);
  await applyConnection(page, vaultId);
  await expect(page.locator('nav[aria-label="Apps"]').first()).toBeVisible();
  return vaultId;
}
