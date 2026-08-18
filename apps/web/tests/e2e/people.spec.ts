import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";

// People north-star journey (#821): the rebuilt v12 render tree over the real
// gateway. A person minted through the app's own write rail lands as a roster
// row, survives a full PWA reload, and opens to the person screen with the
// cadence line and the Log commit. The harness gateway, vault, and inline
// People bundle are all real; only the iroh wire is adapted
// (control-transport.ts). The roster capture is the #821 UI-impact evidence.

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";
const CONTROL_SESSION = "web-e2e-control-session";

const PERSON_NAME = "Ana Whitcombe";
const PERSON_ROLE = "architect";

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

test("People renders a person, survives a reload, and opens the person screen", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await connectPwa(page);
  await openFirstParty(page, "People");

  // The inline replica session bootstraps asynchronously after the app
  // mounts; a write issued before that throws ReplicaRebootstrapRequired.
  // Prove write readiness with the person this journey is about — the intent
  // id makes retries idempotent, so the poll can never mint two of her.
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

  // The write lands as a roster row through the app's own change-stream
  // refresh, with window focus as the sanctioned recovery re-read while the
  // replica is still bootstrapping (`onFocusRefresh` never gates behind a
  // consent banner) — the row's accessible name is the shared Row recipe's.
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

  // THE VAULT LINK, DRAWN. This harness vault is created with the app, so
  // People's `share.*` scopes are granted at install rather than parked for
  // approval: the roster's `links_available` is true, and Ana — minted through
  // `add-person`, holding no binding — carries the DASHED ring rather than the
  // solid one and rather than none.
  await expect(page.locator('[data-link="unlinked"]').first()).toBeVisible();
  // The ring and the two link chips are ONE fact: whatever draws one draws the
  // other, so a roster with rings but no chips is the incoherence this catches.
  await expect(
    page.getByRole("button", { name: "Linked", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Unlinked", exact: true })
  ).toBeVisible();

  // The #821 UI-impact evidence: the rebuilt roster, drawn from tokens.
  const evidenceDir = path.join(
    import.meta.dirname,
    "../../../../artifacts/e2e/ui-impact"
  );
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, "issue-821-people-roster.png"),
    fullPage: true,
  });

  // A person is a vault row, not browser state: she must come back after a
  // full reload of the PWA shell.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('nav[aria-label="Apps"]').waitFor({ state: "visible" });
  await openFirstParty(page, "People");
  await expect(rosterRow.first()).toBeVisible({ timeout: 30_000 });

  // Opening the row lands on the person screen: the hero name, the cadence
  // line in the handoff's own words, and the Log commit. Re-click until the
  // screen answers — right after a reload the row can paint before its React
  // listener attaches, and a click in that window is silently lost.
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
