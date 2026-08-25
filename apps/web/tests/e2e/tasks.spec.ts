import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";

// Tasks on the VIEWER seat (matrix `appSeats`, umbrella #864).
//
// The viewer's claim is not "the app renders": it is that what the member sees
// is a replica of MEANING that survives the seat being thrown away. A task
// minted through the app's own write rail against the real harness gateway
// must land in the RIGHT GROUP — a task due yesterday is overdue, and the
// overdue group is the one that carries the re-entry verbs — and the whole
// arrangement must come back after the PWA is reloaded, service worker,
// replica session and React tree included. Grouping is derived from the due
// date at render time, so a row that came back in the wrong group would be a
// replica that kept the row and lost its meaning.
//
// The harness gateway, vault and inline Tasks bundle are all real; only the
// iroh wire is adapted (control-transport.ts).

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";
const CONTROL_SESSION = "web-e2e-control-session";

const TASK_TITLE = "Renew the passport";
const ADD_INTENT = "tasks-e2e-add-task";

async function openFirstParty(page: Page, name: string): Promise<void> {
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

test("Tasks files a dated task under Overdue and keeps it across a PWA reload", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await connectPwa(page);
  await openFirstParty(page, "Tasks");

  // The inline replica session bootstraps asynchronously after the app mounts;
  // a write issued before that throws ReplicaRebootstrapRequired. Prove write
  // readiness with the task this journey is about — the intent id makes the
  // retries idempotent, so the poll can never mint two of it.
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ title, intentId }) => {
            try {
              const outcome = await window.centraid.write({
                action: "add",
                input: {
                  title,
                  due_at: new Date(
                    Date.now() - 24 * 60 * 60 * 1000
                  ).toISOString(),
                },
                intentId,
              });
              return outcome.status;
            } catch {
              return "replica-not-ready";
            }
          },
          { title: TASK_TITLE, intentId: ADD_INTENT }
        ),
      { timeout: 60_000 }
    )
    .toBe("executed");

  // The write lands as a board row through the app's own change-stream
  // refresh, with window focus as the sanctioned recovery re-read while the
  // replica is still bootstrapping (`onFocusRefresh` never gates behind a
  // consent banner). A row is addressed by its stable `data-task-id`, which is
  // what the row IS — never by a class name, which is presentation.
  const taskRow = page
    .locator("[data-task-id]")
    .filter({ hasText: TASK_TITLE });
  await expect
    .poll(
      async () => {
        if ((await taskRow.count()) > 0) return true;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        return (await taskRow.count()) > 0;
      },
      { timeout: 60_000 }
    )
    .toBe(true);

  // THE GROUP IS THE MEANING. A task due yesterday belongs to Overdue, and
  // Overdue is the one group that carries the two re-entry verbs — so finding
  // them proves the row was filed, not merely stored.
  const overdue = page.locator('div[data-attention="true"]');
  await expect(overdue.first()).toBeVisible();
  await expect(overdue.getByText("Overdue").first()).toBeVisible();
  await expect(
    overdue.getByRole("button", { name: "Move all to today", exact: true })
  ).toBeVisible();
  await expect(taskRow.first()).toBeVisible();

  // A task is a vault row, not browser state: both the row and the group it
  // was filed into must come back after a full reload of the PWA shell.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('nav[aria-label="Apps"]').waitFor({ state: "visible" });
  await openFirstParty(page, "Tasks");
  await expect(taskRow.first()).toBeVisible({ timeout: 30_000 });
  await expect(
    overdue.getByRole("button", { name: "Move all to today", exact: true })
  ).toBeVisible({ timeout: 30_000 });
});
