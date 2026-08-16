import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  installHarnessControlTransport,
  setHarnessControlOnline,
} from "./control-transport.js";

// Offline write / reconnect replay (#781, originally #717): a write made with
// the gateway unreachable lands in the durable replica outbox, survives a
// full PWA reload while still offline, and after the gateway returns it
// settles into exactly one canonical vault row — replayed, not duplicated.
// This is the host-network reliability journey TESTING.md names: the harness
// transport toggle is the host's network control, and everything behind it —
// service worker, IndexedDB outbox, intent identity, gateway dispatch, vault
// row — is real. The mobile-native (Maestro airplane-mode) variant of the
// same contract remains open under #781.

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";
const CONTROL_SESSION = "web-e2e-control-session";

const TASK_TITLE = "Offline reconnect task";

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

/** Open tasks with the given exact title in the canonical board read. */
async function boardTitleCount(page: Page, title: string): Promise<number> {
  type Board = { open: Array<{ title: string }> };
  const board = await page.evaluate(() =>
    window.centraid.read<Board>({ query: "board", input: {} })
  );
  return board.open.filter((task) => task.title === title).length;
}

test("an offline write survives a reload and settles exactly once on reconnect", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await connectPwa(page);

  // Warm the Tasks bundle and replica session while the gateway is up.
  await openFirstParty(page, "Tasks");
  await expect
    .poll(
      async () => {
        try {
          return await boardTitleCount(page, TASK_TITLE);
        } catch {
          return -1;
        }
      },
      { timeout: 30_000 }
    )
    .toBe(0);
  // Write-rail readiness must be proven BEFORE severing the gateway: the
  // replica session bootstraps asynchronously, an offline session can never
  // finish bootstrapping, and a write issued before it does throws
  // not-bootstrapped instead of queueing. Probe with a write the vault
  // deterministically REFUSES (set-status on a task that does not exist), so
  // readiness is proven without minting a row.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          try {
            const outcome = await window.centraid.write({
              action: "set-status",
              input: { task_id: "offline-e2e-readiness-probe", status: "done" },
              intentId: "offline-e2e-readiness-probe",
            });
            return outcome.status;
          } catch {
            return "replica-not-ready";
          }
        }),
      { timeout: 30_000 }
    )
    .not.toBe("replica-not-ready");

  // Sever the gateway and write through the visible product control that
  // is already on screen. Do not remount Tasks after the toggle: opening
  // the same route again starts a new replica walk, an offline walk cannot
  // finish, and the add then throws not-bootstrapped instead of queueing.
  // pending-overlay remounts by switching FROM another app, which reuses
  // the warm session (idle grace). This journey stays on the session the
  // readiness probe already proved. The next write's drain sees the dead
  // harness transport and admits the intent as queued.
  await setHarnessControlOnline(page, false);
  await page.getByRole("textbox", { name: "Task title" }).fill(TASK_TITLE);
  await page.getByRole("button", { name: "Today", exact: true }).click();
  // Severing the harness can race a replica rebootstrap ("not-bootstrapped")
  // against the Add click. Retry the product control until the outbox
  // projects the row — a single click that lands in the gap throws instead
  // of queueing, and getByText never sees a list item.
  const queuedRow = page.getByText(TASK_TITLE, { exact: true });
  await expect
    .poll(
      async () => {
        if (await queuedRow.isVisible()) return true;
        await page.getByRole("button", { name: "Add", exact: true }).click();
        return queuedRow.isVisible();
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  await expect(page.locator(".kit-pending-chip")).toHaveText("queued");

  // The queued write is durable: a full reload while STILL offline must
  // restore both the row and its queued state from the local outbox.
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFirstParty(page, "Tasks");
  await expect(page.getByText(TASK_TITLE, { exact: true })).toBeVisible();
  await expect(page.locator(".kit-pending-chip")).toHaveText("queued");

  // Reconnect. The next session boot drains the outbox against the live
  // gateway; `executed` settlement removes the overlay in favour of the
  // canonical row, so the pending chip must clear and the task must stay.
  await setHarnessControlOnline(page, true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFirstParty(page, "Tasks");
  await expect(page.getByText(TASK_TITLE, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator(".kit-pending-chip")).toHaveCount(0, {
    timeout: 60_000,
  });

  // Landed exactly once: one visible row, and one canonical vault row via
  // the board read — replay must be idempotent, not additive.
  await expect(page.getByText(TASK_TITLE, { exact: true })).toHaveCount(1);
  await expect
    .poll(() => boardTitleCount(page, TASK_TITLE), { timeout: 30_000 })
    .toBe(1);

  // And the settled row is the vault's, not the overlay's: a fresh reload
  // (fresh in-memory session over the same gateway) still shows it settled.
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFirstParty(page, "Tasks");
  await expect(page.getByText(TASK_TITLE, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator(".kit-pending-chip")).toHaveCount(0);
  await expect
    .poll(() => boardTitleCount(page, TASK_TITLE), { timeout: 30_000 })
    .toBe(1);
});
