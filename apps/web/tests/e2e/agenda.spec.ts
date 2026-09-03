import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";
const CONTROL_SESSION = "web-e2e-control-session";

const EVENT_TITLE = "Roof survey";
const PROPOSE_INTENT = "agenda-e2e-propose-event";

async function openFirstParty(page: Page, name: string): Promise<void> {
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

async function showSchedule(page: Page): Promise<void> {
  const schedule = page.getByRole("button", { name: "Schedule", exact: true });
  await expect
    .poll(
      async () => {
        if ((await schedule.count()) === 0) return false;
        await schedule.first().click();
        return true;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
}

test("Agenda paints a proposed event and it survives a PWA reload", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await connectPwa(page);
  await openFirstParty(page, "Agenda");

  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ title, intentId }) => {
            try {
              const upcoming = await window.centraid.read<{
                calendars?: Array<{ calendar_id: string }>;
              }>({ query: "upcoming", input: {} });
              const calendarId = upcoming.calendars?.[0]?.calendar_id;
              if (!calendarId) return "no-calendar";
              const start = new Date(Date.now() + 26 * 60 * 60 * 1000);
              start.setMinutes(0, 0, 0);
              const outcome = await window.centraid.write({
                action: "propose",
                input: {
                  summary: title,
                  dtstart: start.toISOString(),
                  dtend: new Date(
                    start.getTime() + 60 * 60 * 1000
                  ).toISOString(),
                  calendar_id: calendarId,
                },
                intentId,
              });
              return outcome.status;
            } catch {
              return "replica-not-ready";
            }
          },
          { title: EVENT_TITLE, intentId: PROPOSE_INTENT }
        ),
      { timeout: 60_000 }
    )
    .toBe("executed");

  await showSchedule(page);
  const eventRow = page
    .locator("[data-event-id]")
    .filter({ hasText: EVENT_TITLE });
  await expect
    .poll(
      async () => {
        if ((await eventRow.count()) > 0) return true;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        return (await eventRow.count()) > 0;
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  await expect(eventRow.first()).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('nav[aria-label="Apps"]').waitFor({ state: "visible" });
  await openFirstParty(page, "Agenda");
  await showSchedule(page);
  await expect(eventRow.first()).toBeVisible({ timeout: 30_000 });

  const detail = page.locator(`aside[aria-label="${EVENT_TITLE}"]`);
  await expect
    .poll(
      async () => {
        if (await detail.isVisible()) return true;
        if ((await eventRow.count()) > 0) await eventRow.first().click();
        return detail.isVisible();
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  await expect(
    detail.getByRole("button", { name: "Ask to cancel", exact: true })
  ).toBeVisible();
});
