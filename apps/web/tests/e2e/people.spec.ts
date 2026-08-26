import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";

// People north-star journey (#821): a person minted through the app's own
// write rail lands as a roster row, survives a full PWA reload, and opens to
// the person screen.

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";
const CONTROL_SESSION = "web-e2e-control-session";

const PERSON_NAME = "Ana Whitcombe";
const PERSON_ROLE = "architect";

async function openFirstParty(page: Page, name: string): Promise<void> {
  // Re-click until open: right after a reload a click lands before listeners attach.
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
  await palette.locator("input").fill(name);
  await palette.getByRole("button").filter({ hasText: name }).first().click();
  await expect(page.getByTestId("inline-app-view")).toBeVisible();
  await expect(page.getByText(`Loading ${name}…`, { exact: true })).toHaveCount(
    0
  );
  await expect
    .poll(() => page.evaluate(() => Boolean(window.centraid)))
    .toBe(true);
}

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
    const vaultsPath = encodeURIComponent("/centraid/_vault/vaults");
    const response = await fetch(
      `${apiUrl}/centraid/_web/control?path=${vaultsPath}`,
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

test("People renders a person, survives a reload, and opens the person screen", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await connectPwa(page);
  await openFirstParty(page, "People");

  // The replica session bootstraps asynchronously; an earlier write throws.
  // The intent id keeps retries idempotent.
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ name, role }) => {
            try {
              const outcome = await window.centraid.write({
                action: "add-person",
                input: { display_name: name, role, cadence_days: 30 },
                intentId: "people-e2e-add-person",
              });
              return outcome.status;
            } catch {
              return "replica-not-ready";
            }
          },
          { name: PERSON_NAME, role: PERSON_ROLE }
        ),
      { timeout: 60_000 }
    )
    .toBe("executed");

  // The write lands via the app's change-stream refresh; window focus is the
  // sanctioned recovery re-read while still bootstrapping.
  const rosterRow = page.getByRole("button", { name: `Open ${PERSON_NAME}` });
  await expect
    .poll(
      async () => {
        if ((await rosterRow.count()) > 0) return true;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        return (await rosterRow.count()) > 0;
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  await expect(rosterRow.first()).toBeVisible();

  // THE VAULT LINK, DRAWN: the harness vault grants People's `share.*` scopes
  // at install, so `links_available` is true; Ana carries the DASHED ring.
  await expect(page.locator('[data-link="unlinked"]').first()).toBeVisible();
  // Ring chips and link chips are ONE fact; rings without chips is incoherent.
  await expect(
    page.getByRole("button", { name: "Linked", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Unlinked", exact: true })
  ).toBeVisible();

  // #821 UI-impact evidence: the rebuilt roster, drawn from tokens.
  const evidenceDir = path.join(
    import.meta.dirname,
    "../../../../artifacts/e2e/ui-impact"
  );
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, "issue-821-people-roster.png"),
    fullPage: true,
  });

  // A person is a vault row, not browser state: she survives a full reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('nav[aria-label="Apps"]').waitFor({ state: "visible" });
  await openFirstParty(page, "People");
  await expect(rosterRow.first()).toBeVisible({ timeout: 30_000 });

  // Row opens the person screen: hero name, cadence line, Log commit.
  // Re-click until it answers — post-reload clicks land before listeners attach.
  const personScreen = page.locator('section[aria-label="Person"]');
  await expect
    .poll(
      async () => {
        if (await personScreen.isVisible()) return true;
        if ((await rosterRow.count()) > 0) await rosterRow.first().click();
        return personScreen.isVisible();
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  await expect(personScreen.getByText(PERSON_NAME).first()).toBeVisible();
  await expect(page.getByText(/^Every 30 days · last /u)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Log", exact: true })
  ).toBeVisible();
});
