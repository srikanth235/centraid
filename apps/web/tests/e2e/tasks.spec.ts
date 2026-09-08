import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  installHarnessControlTransport,
  setHarnessControlOnline,
} from "./control-transport.js";

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

// The board's open read clamps its window to a floor of 20 (`board.ts`), so 21
// open tasks is the smallest set that provably fills a window a caller chose.
const TRUNCATION_WINDOW = 20;
const TRUNCATION_SEED = TRUNCATION_WINDOW + 1;
const TRUNCATION_NOTICE = "Showing the newest 20; more not loaded";
const UI_IMPACT_DIR = "artifacts/e2e/ui-impact";
const UI_IMPACT_SHOT = "issue-922-web-truncation-status.png";
const UI_IMPACT_PENDING_SHOT = "issue-922-web-queued-pending-task.png";
const DELETE_TITLE = "Queued delete target";
const MINTED_TITLE = "Queued minted task";
const MINTED_ID_RE =
  /^[\da-f]{8}-[\da-f]{4}-8[\da-f]{3}-8[\da-f]{3}-[\da-f]{12}$/iu;

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

// TRUNCATION IS NEVER SILENT, ON THE WEB SEAT (#922 0a).
//
// The claim under test is not "a bound exists" — it always did — but that a
// bound the member cannot see is now spoken. A window that FILLS is the one
// state a shorter list cannot be told apart from a complete one by looking, so
// the seat says so on the frame's one status line, in the shared phrase both
// seats print (`truncatedListNotice`). Twenty-one open tasks against a window
// of twenty is the smallest honest way to reach it: real writes through the
// app's own rail, the real board query, the real replica read.
test("Tasks says so on the status line when a read's window cuts the board short", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await connectPwa(page);
  await openFirstParty(page, "Tasks");

  // Same readiness poll as the journey above, on the FIRST seeded task: the
  // replica session bootstraps after the app mounts, and a write before that
  // throws. The intent id makes every retry idempotent.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          try {
            const outcome = await window.centraid.write({
              action: "add",
              input: { title: "Truncation seed 0" },
              intentId: "tasks-e2e-truncation-0",
            });
            return outcome.status;
          } catch {
            return "replica-not-ready";
          }
        }),
      { timeout: 60_000 }
    )
    .toBe("executed");

  // Minted together, settled together: the outbox is what serialises intents,
  // and each carries its own id, so issuing them in one batch cannot reorder
  // anything the board then reads.
  const seeded = await page.evaluate(async (total: number) => {
    const outcomes = await Promise.all(
      Array.from({ length: total - 1 }, (_unused, offset) => {
        const index = offset + 1;
        return window.centraid.write({
          action: "add",
          input: { title: `Truncation seed ${index}` },
          intentId: `tasks-e2e-truncation-${index}`,
        });
      })
    );
    return outcomes.map((outcome) => outcome.status);
  }, TRUNCATION_SEED);
  expect(seeded).toHaveLength(TRUNCATION_SEED - 1);
  expect(new Set(seeded)).toStrictEqual(new Set(["executed"]));

  // The board query's own door, with the window the caller chooses. The read
  // fills it, and the read itself — not the app — posts the line, which is the
  // whole point: no screen can forget to.
  //
  // A note decays after six seconds, so the read is re-issued inside the poll
  // rather than once before it; the poll can never race its own evidence away.
  const statusLine = page.getByRole("status");
  await expect
    .poll(
      async () => {
        await page.evaluate(async (limit: number) => {
          await window.centraid.read({ query: "board", input: { limit } });
        }, TRUNCATION_WINDOW);
        return (await statusLine.first().textContent()) ?? "";
      },
      { timeout: 60_000 }
    )
    .toContain(TRUNCATION_NOTICE);

  await expect(statusLine.first()).toContainText(TRUNCATION_NOTICE);

  const evidenceDir = path.resolve(
    import.meta.dirname,
    "../../../../",
    UI_IMPACT_DIR
  );
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, UI_IMPACT_SHOT),
    fullPage: false,
  });
});

// QUEUED DESTRUCTIVE PROJECTION AND A MINTED PENDING ROW (#922 G1 / G2).
//
// Two claims the overlay and minted-id slices actually ship, photographed
// together because they share the offline write rail. A landed task deleted
// while the gateway is down must LEAVE the board — a plain patch would leave
// it wearing a badge. A task added on that same rail must appear at once with
// the id the seat minted (canonical UUIDv8, not `pending:…`) and say so.
test("Tasks hides a queued delete and shows a minted pending add", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await connectPwa(page);
  await openFirstParty(page, "Tasks");

  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ title, intentId }) => {
            try {
              const outcome = await window.centraid.write({
                action: "add",
                input: { title },
                intentId,
              });
              return outcome.status;
            } catch {
              return "replica-not-ready";
            }
          },
          { title: DELETE_TITLE, intentId: "tasks-e2e-queued-delete-target" }
        ),
      { timeout: 60_000 }
    )
    .toBe("executed");

  const landed = page
    .locator("[data-task-id]")
    .filter({ hasText: DELETE_TITLE });
  await expect
    .poll(
      async () => {
        if ((await landed.count()) > 0) return true;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        return (await landed.count()) > 0;
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  const landedId = await landed.first().getAttribute("data-task-id");
  expect(typeof landedId).toBe("string");
  if (typeof landedId !== "string") throw new Error("landed task has no id");

  // Stay on this session: remounting starts a replica walk an offline session
  // cannot finish, and the writes would throw instead of queueing.
  await setHarnessControlOnline(page, false);
  await page.evaluate(
    async ({ id, intentId }) =>
      window.centraid.write({
        action: "delete",
        input: { task_id: id },
        intentId,
      }),
    { id: landedId, intentId: "tasks-e2e-queued-delete" }
  );
  await expect
    .poll(
      async () => {
        if ((await landed.count()) === 0) return true;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        return (await landed.count()) === 0;
      },
      { timeout: 60_000 }
    )
    .toBe(true);

  await page.evaluate(
    async ({ title, intentId }) =>
      window.centraid.write({
        action: "add",
        input: { title },
        intentId,
      }),
    { title: MINTED_TITLE, intentId: "tasks-e2e-queued-minted-add" }
  );
  const pendingRow = page
    .locator("[data-task-id][data-pending='true']")
    .filter({ hasText: MINTED_TITLE });
  await expect
    .poll(
      async () => {
        if ((await pendingRow.count()) > 0) return true;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        return (await pendingRow.count()) > 0;
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  await expect(pendingRow.first()).toBeVisible();
  await expect(pendingRow.locator(".kit-pending-chip").first()).toHaveText(
    /^(?:queued|pending)$/u
  );
  await expect(pendingRow.first()).toContainText("not in the vault yet");
  expect(await pendingRow.first().getAttribute("data-task-id")).toMatch(
    MINTED_ID_RE
  );

  const evidenceDir = path.resolve(
    import.meta.dirname,
    "../../../../",
    UI_IMPACT_DIR
  );
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, UI_IMPACT_PENDING_SHOT),
    fullPage: false,
  });
});
