import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";

// Notes on the VIEWER seat (matrix `appSeats`, umbrella #864).
//
// The viewer's claim is not "the app renders": it is that what the member sees
// is a replica of MEANING that survives the seat being thrown away. A passage
// written through the app's own write rail against the real harness gateway
// lands as a library row, the whole PWA is reloaded — service worker, replica
// session and React tree all gone — and the row must come back AND still be
// carrying its body when the editor opens on it. A library row ships a preview
// and never a body (the body is a second read on open), so surviving that
// second read is the half of this claim a row check alone would miss.
//
// The harness gateway, vault and inline Notes bundle are all real; only the
// iroh wire is adapted (control-transport.ts).

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";
const CONTROL_SESSION = "web-e2e-control-session";

const NOTE_TITLE = "Lease terms";
const NOTE_BODY = "The deposit clause moved to §4 and the notice runs 60 days.";
const CREATE_INTENT = "notes-e2e-create-note";

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

test("Notes keeps a passage's heading, preview and body across a PWA reload", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await connectPwa(page);
  await openFirstParty(page, "Notes");

  // The inline replica session bootstraps asynchronously after the app mounts;
  // a write issued before that throws ReplicaRebootstrapRequired. Prove write
  // readiness with the note this journey is about — the intent id makes the
  // retries idempotent, so the poll can never mint two of it.
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ title, body, intentId }) => {
            try {
              const outcome = await window.centraid.write({
                action: "create-note",
                input: { title, body_text: body },
                intentId,
              });
              return outcome.status;
            } catch {
              return "replica-not-ready";
            }
          },
          { title: NOTE_TITLE, body: NOTE_BODY, intentId: CREATE_INTENT }
        ),
      { timeout: 60_000 }
    )
    .toBe("executed");

  // The write lands as a library row through the app's own change-stream
  // refresh, with window focus as the sanctioned recovery re-read while the
  // replica is still bootstrapping (`onFocusRefresh` never gates behind a
  // consent banner). The row carries BOTH halves the library promises: the
  // heading the member typed, and the preview the projection flattened.
  const heading = page.getByText(NOTE_TITLE, { exact: true });
  await expect
    .poll(
      async () => {
        if ((await heading.count()) > 0) return true;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        return (await heading.count()) > 0;
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  await expect(heading.first()).toBeVisible();
  await expect(
    page.getByText(NOTE_BODY, { exact: true }).first()
  ).toBeVisible();

  // A passage is a vault row, not browser state: it must come back after a
  // full reload of the PWA shell.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('nav[aria-label="Apps"]').waitFor({ state: "visible" });
  await openFirstParty(page, "Notes");
  await expect(heading.first()).toBeVisible({ timeout: 30_000 });

  // Opening the row lands in the editor with the BODY — a second read the
  // library row never carried. Re-click until the editor answers: right after
  // a reload the row can paint before its React listener attaches, and a click
  // in that window is silently lost.
  const body = page.getByRole("textbox", { name: "Note body" });
  await expect
    .poll(
      async () => {
        if ((await body.count()) > 0) return true;
        if ((await heading.count()) > 0) await heading.first().click();
        return (await body.count()) > 0;
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  await expect(body.first()).toHaveValue(NOTE_BODY);
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(
    NOTE_TITLE
  );
});
