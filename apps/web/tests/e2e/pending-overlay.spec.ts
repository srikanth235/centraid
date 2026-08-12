import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  installHarnessControlTransport,
  setHarnessControlOnline,
} from "./control-transport.js";

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";
const CONTROL_SESSION = "web-e2e-control-session";

async function openFirstParty(page: Page, name: string): Promise<void> {
  const search = page.getByRole("button", { name: /^Search/u });
  if ((await search.count()) > 0) await search.first().click();
  else await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
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

async function prepareTally(page: Page): Promise<void> {
  await openFirstParty(page, "Tally");
  type Dashboard = { friends: Array<{ party_id: string }> };
  let dashboard: Dashboard | undefined;
  await expect
    .poll(
      async () => {
        try {
          dashboard = await page.evaluate(() =>
            window.centraid.read<Dashboard>({ query: "dashboard", input: {} })
          );
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  let memberId = dashboard!.friends[0]?.party_id;
  if (!memberId) {
    let friend: { status: string; partyId?: string } | undefined;
    await expect
      .poll(
        async () => {
          friend = await page.evaluate(async () => {
            try {
              const outcome = await window.centraid.write({
                action: "add-friend",
                input: { name: "Offline Teammate" },
                intentId: "pwa-pending-overlay-setup-friend",
              });
              return {
                status: outcome.status,
                partyId: outcome.output?.["party_id"] as string | undefined,
              };
            } catch {
              return { status: "replica-not-ready" };
            }
          });
          return friend.status;
        },
        { timeout: 30_000 }
      )
      .toBe("executed");
    memberId = friend?.partyId;
  }
  expect(memberId).toEqual(expect.any(String));
  await expect
    .poll(
      () =>
        page.evaluate(async (readyMemberId) => {
          try {
            const group = await window.centraid.write({
              action: "create-group",
              input: {
                name: "Offline Journey",
                icon: "🏠",
                color: "#6f5bf6",
                member_ids: [readyMemberId],
              },
              intentId: "pwa-pending-overlay-setup-group",
            });
            return group.status;
          } catch {
            return "replica-not-ready";
          }
        }, memberId!),
      { timeout: 30_000 }
    )
    .toBe("executed");
}

async function prepareAgenda(page: Page): Promise<void> {
  await openFirstParty(page, "Agenda");
  type Upcoming = {
    calendars: Array<{ calendar_id: string }>;
  };
  type Parties = {
    parties: Array<{ party_id: string; is_you?: boolean }>;
  };
  let setup: { upcoming: Upcoming; parties: Parties } | undefined;
  await expect
    .poll(
      async () => {
        try {
          setup = await page.evaluate(async () => {
            const client = window.centraid;
            const [upcoming, parties] = await Promise.all([
              client.read<Upcoming>({
                query: "upcoming",
                input: {
                  from: new Date(Date.now() - 86_400_000).toISOString(),
                },
              }),
              client.read<Parties>({ query: "parties", input: {} }),
            ]);
            return { upcoming, parties };
          });
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  const outcome = await page.evaluate(async (ready) => {
    const client = window.centraid;
    const start = new Date(Date.now() + 86_400_000);
    return client.write({
      action: "propose",
      input: {
        summary: "Offline RSVP planning",
        calendar_id: ready.upcoming.calendars[0]!.calendar_id,
        dtstart: start.toISOString(),
        dtend: new Date(start.getTime() + 3_600_000).toISOString(),
        start_tz: "UTC",
        attendee_party_ids: [
          ready.parties.parties.find((party) => party.is_you)!.party_id,
        ],
      },
    });
  }, setup!);
  expect(outcome.status).toBe("executed");
}

test("production PWA routes recover Tally, Tasks, and Agenda pending rows while still offline", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await connectPwa(page);
  await prepareTally(page);
  await prepareAgenda(page);
  await openFirstParty(page, "Tasks");
  await openFirstParty(page, "Tally");
  await openFirstParty(page, "Agenda");
  await expect(
    page.getByRole("button", { name: /Offline RSVP planning/u })
  ).toBeVisible({ timeout: 30_000 });
  await setHarnessControlOnline(page, false);

  await openFirstParty(page, "Tasks");
  await page.getByRole("textbox", { name: "Task title" }).fill("Offline task");
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Offline task", { exact: true })).toBeVisible();

  await openFirstParty(page, "Tally");
  await page.getByText("Offline Journey", { exact: true }).first().click();
  await page.getByRole("button", { name: "Add expense" }).click();
  await page.getByPlaceholder("What was it for?").fill("Offline lunch");
  await page.locator('input[inputmode="decimal"]').first().fill("12.50");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Offline lunch", { exact: true })).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  await openFirstParty(page, "Agenda");
  const plannedEvent = page.getByRole("button", {
    name: /Offline RSVP planning/u,
  });
  await expect(plannedEvent).toBeVisible();
  await plannedEvent.click();
  await page.getByRole("button", { name: "Going" }).click();
  await expect(page.getByRole("dialog")).toHaveClass(/kit-pending/u);
  await expect(
    page.getByRole("dialog").locator(".kit-pending-chip")
  ).toHaveText("queued");

  await page.reload({ waitUntil: "domcontentloaded" });
  await openFirstParty(page, "Agenda");
  const restoredEvent = page.getByRole("button", {
    name: /Offline RSVP planning/u,
  });
  await expect(restoredEvent).toBeVisible();
  await restoredEvent.click();
  await expect(page.getByRole("dialog")).toHaveClass(/kit-pending/u);
  await expect(
    page.getByRole("dialog").locator(".kit-pending-chip")
  ).toHaveText("queued");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  await openFirstParty(page, "Tasks");
  await expect(page.getByText("Offline task", { exact: true })).toBeVisible();
  await expect(page.locator(".kit-pending-chip")).toHaveText("queued");

  await openFirstParty(page, "Tally");
  await page.getByText("Offline Journey", { exact: true }).first().click();
  await expect(page.getByText("Offline lunch", { exact: true })).toBeVisible();
  const tallyPending = page.locator(".kit-pending-chip");
  await expect(tallyPending).toHaveText("pending");
  await expect(tallyPending).toHaveAttribute(
    "title",
    "Waiting for a connection."
  );
});
