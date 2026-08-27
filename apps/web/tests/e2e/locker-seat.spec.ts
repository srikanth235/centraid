import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";

// Locker × viewer seat (docs/blueprint-seats.md S5): Locker declares
// `disabledOn: ["viewer"]`, so its web journey IS the refusal — the shell
// must state the seat wall plainly instead of mounting the app, because a
// shared browser is the risky seat for secrets. The desktop journey
// (apps/desktop/tests/e2e/locker.spec.ts) owns the custodian-seat
// passphrase/unlock/persistence proof. #781.

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";
const CONTROL_SESSION = "web-e2e-control-session";

async function connectPwa(page: Page): Promise<void> {
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
  await page.context().addCookies([
    {
      name: "__centraid_control",
      value: CONTROL_SESSION,
      domain: "127.0.0.1",
      path: "/centraid/_web/control",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const enrolledVault = await page.evaluate(async (apiUrl) => {
    const path = encodeURIComponent("/centraid/_vault/vaults");
    const response = await fetch(
      `${apiUrl}/centraid/_web/control?path=${path}`,
      {
        credentials: "include",
      }
    );
    const body = (await response.json()) as {
      vaults?: Array<{ vaultId: string }>;
    };
    return { status: response.status, vaultId: body.vaults?.[0]?.vaultId };
  }, API_URL);
  expect(enrolledVault.status).toBe(200);
  expect(enrolledVault.vaultId).toEqual(expect.any(String));
  const vaultId = enrolledVault.vaultId!;
  await page.evaluate(
    ({ endpointId, endpointTicket, vault }) => {
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
  await page.locator('nav[aria-label="Apps"]').waitFor({ state: "visible" });
}

test("Locker refuses the viewer seat with the manifest-declared wall", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await connectPwa(page);
  // Re-click until the palette actually opens: right after a reload the Search
  // button can paint before its React listener attaches, and a click that
  // lands in that window is silently lost.
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect
    .poll(
      async () => {
        if (await palette.isVisible()) return true;
        const search = page.getByRole("button", { name: /^Search/u });
        if ((await search.count()) > 0) await search.first().click();
        else await page.keyboard.press("ControlOrMeta+k");
        return palette.isVisible();
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  await palette.waitFor({ state: "visible" });
  await palette.locator("input").fill("Locker");
  await palette
    .getByRole("button")
    .filter({ hasText: "Locker" })
    .first()
    .click();
  await expect(page.getByTestId("inline-app-view")).toBeVisible();

  // The refusal grammar: a title and one sentence of reason, no retry —
  // the seat itself is what refuses. And no Locker surface may mount: the
  // lock screen dialog must never appear on this seat.
  const refusal = page.getByTestId("inline-app-seat-refusal");
  await expect(refusal).toBeVisible({ timeout: 30_000 });
  await expect(refusal).toContainText(
    "Locker does not open on a shared browser"
  );
  await expect(refusal).toContainText(
    "A shared browser cannot hold the user-presence boundary this app depends on, so Locker refuses the seat outright."
  );
  await expect(refusal).toContainText(
    "Use the desktop app beside your gateway, or your phone."
  );
  await expect(refusal.getByRole("button")).toHaveCount(0);
  await expect(page.getByText("Protect your Locker")).toHaveCount(0);
});
