import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";

/*
 * The connected-session bootstrap, in one place (#892). A spec whose private
 * copy predates a change to the connection shape asserts against a connection
 * onboarding no longer writes — and stays green doing it.
 *
 * Two steps plus a composition rather than one call because `web-pwa` asserts
 * the control cookie BETWEEN them: its claim is that the POST establishes an
 * httpOnly session, so that assertion stays where it was, before the reload.
 *
 * Ten older specs still carry their own copies, in an earlier variant (cookie
 * added by hand, vault id read back from `/_vault/vaults`). Converting them has
 * its own blast radius; logged in QUALITY.md instead.
 */

export const API_URL = "http://127.0.0.1:48765";
export const ADMIN_TOKEN = "centraid-web-e2e-token";
export const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
export const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";

/**
 * Install the harness transport, load the app, and mint a control session.
 *
 * @param page the Playwright page to bootstrap
 * @returns the vault id the harness gateway enrolled
 */
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

/**
 * Persist the connection onboarding would have written, then reload to apply it.
 *
 * @param page the Playwright page holding a minted control session
 * @param vaultId the vault the persisted connection should name
 */
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

/**
 * Bring `page` all the way to a connected Home shell.
 *
 * @param page the Playwright page to connect
 * @returns the vault id the harness gateway enrolled
 */
export async function connectPwa(page: Page): Promise<string> {
  const vaultId = await mintControlSession(page);
  await applyConnection(page, vaultId);
  await expect(page.locator('nav[aria-label="Apps"]').first()).toBeVisible();
  return vaultId;
}
