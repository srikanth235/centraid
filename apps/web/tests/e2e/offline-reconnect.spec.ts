import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  installHarnessControlTransport,
  setHarnessControlOnline,
} from "./control-transport.js";

// Offline write / reconnect replay (#781): a write made with the gateway down
// survives a full reload offline and settles into exactly one vault row on
// reconnect. The rename goes through the door Docs' own handler calls.

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";
const CONTROL_SESSION = "web-e2e-control-session";

const DOC_TITLE = "offline-reconnect.txt";
const DOC_BODY = "Written before the gateway went away.";
const RENAMED_TITLE = "offline-reconnect-renamed.txt";
const RENAME_INTENT = "offline-e2e-rename-intent";

async function openFirstParty(page: Page, name: string): Promise<void> {
  // Re-click until the palette opens: after a reload Search can paint before
  // its listener attaches, and that click is silently lost.
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

async function driveIdsFor(page: Page, title: string): Promise<string[]> {
  type Drive = { documents: Array<{ document_id: string; title: string }> };
  const drive = await page.evaluate(() =>
    window.centraid.read<Drive>({ query: "drive", input: {} })
  );
  return drive.documents
    .filter((doc) => doc.title === title)
    .map((doc) => doc.document_id);
}

test("an offline write survives a reload and settles exactly once on reconnect", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await connectPwa(page);

  await openFirstParty(page, "Docs");
  // Prove the write rail BEFORE severing: an offline session never finishes
  // bootstrapping, so a write issued first throws instead of queueing. The
  // probe is a write the vault refuses, so it mints no row.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          try {
            const outcome = await window.centraid.write({
              action: "upload",
              input: { staged_sha: "0".repeat(64), title: "readiness-probe" },
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

  // The canonical row the offline write decorates, minted while online.
  await page.locator('input[aria-label="Upload files"]').setInputFiles({
    name: DOC_TITLE,
    mimeType: "text/plain",
    buffer: Buffer.from(DOC_BODY, "utf8"),
  });
  await expect(
    page.getByRole("button", { name: `Select ${DOC_TITLE}` })
  ).toBeVisible({ timeout: 30_000 });
  let documentId = "";
  await expect
    .poll(
      async () => {
        const ids = await driveIdsFor(page, DOC_TITLE);
        documentId = ids[0] ?? "";
        return ids.length;
      },
      { timeout: 30_000 }
    )
    .toBe(1);

  // Never remount Docs after the toggle: a fresh replica walk cannot finish
  // offline, and the write then throws instead of queueing.
  await setHarnessControlOnline(page, false);
  await page.evaluate(
    async ({ id, title, intentId }) =>
      window.centraid.write({
        action: "rename",
        input: { document_id: id, title },
        intentId,
      }),
    { id: documentId, title: RENAMED_TITLE, intentId: RENAME_INTENT }
  );

  await expect(
    page.getByRole("button", { name: `Select ${RENAMED_TITLE}` })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".kit-pending-chip").first()).toHaveText("queued");

  // Either honest word for "still in the outbox" passes — `queued` before the
  // drain tries, `pending` after; a settled row or a denial never does.
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFirstParty(page, "Docs");
  await expect(
    page.getByRole("button", { name: `Select ${RENAMED_TITLE}` })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".kit-pending-chip").first()).toHaveText(
    /^(?:queued|pending)$/u
  );

  await setHarnessControlOnline(page, true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFirstParty(page, "Docs");
  await expect(
    page.getByRole("button", { name: `Select ${RENAMED_TITLE}` })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".kit-pending-chip")).toHaveCount(0, {
    timeout: 60_000,
  });

  // Replay is idempotent, not additive: never a second row beside the original.
  await expect
    .poll(() => driveIdsFor(page, RENAMED_TITLE), { timeout: 30_000 })
    .toEqual([documentId]);
  expect(await driveIdsFor(page, DOC_TITLE)).toEqual([]);

  await page.reload({ waitUntil: "domcontentloaded" });
  await openFirstParty(page, "Docs");
  await expect(
    page.getByRole("button", { name: `Select ${RENAMED_TITLE}` })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".kit-pending-chip")).toHaveCount(0);
  await expect
    .poll(() => driveIdsFor(page, RENAMED_TITLE), { timeout: 30_000 })
    .toEqual([documentId]);
});
