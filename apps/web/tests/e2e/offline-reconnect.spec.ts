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
//
// It drove Tasks until that interface was removed pending a ground-up
// redesign, and now drives Docs — the remaining app whose production rows
// render the shared pending overlay (`apps/docs/components/List.tsx` →
// `_shared/PendingWriteActions.tsx`). It also pins, for this seat, the pending
// state a member can SEE, across a reload, not merely a durable outbox row
// (#781).
//
// The offline write is issued through `window.centraid.write` rather than a
// toolbar control ON PURPOSE. Docs' rename affordances live in the sidebar the
// inline seat hides and behind the Quick Look info panel, so a UI-driven
// rename would spend the journey proving navigation. The door used is the one
// the app's own handler calls, and every observable after it — the optimistic
// title, the pending chip, their survival, their settlement — is the
// production UI's.

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

/** The document ids the drive read carries for a given exact title. */
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

  // Warm the Docs bundle and replica session while the gateway is up.
  await openFirstParty(page, "Docs");
  // Write-rail readiness must be proven BEFORE severing the gateway: the
  // replica session bootstraps asynchronously, an offline session can never
  // finish bootstrapping, and a write issued before it does throws
  // not-bootstrapped instead of queueing. Probe with a write the vault
  // deterministically REFUSES (an unstaged sha fails add_document's
  // staged_or_owned precondition), so readiness is proven without minting a
  // row.
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

  // One real document through the product's own upload control, while the
  // gateway is still reachable: this is the canonical row the offline write
  // then decorates, and the row whose settlement is counted at the end.
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

  // Sever the gateway and rename through the door the app's own handler
  // calls. Do not remount Docs after the toggle: opening the same route again
  // starts a new replica walk, an offline walk cannot finish, and the write
  // then throws not-bootstrapped instead of queueing. This journey stays on
  // the session the readiness probe already proved.
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

  // The overlay is the member's answer, painted by the production row: the new
  // title stands where the old one was, and the row says it has not landed.
  await expect(
    page.getByRole("button", { name: `Select ${RENAMED_TITLE}` })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".kit-pending-chip").first()).toHaveText("queued");

  // The queued write is durable: a full reload while STILL offline must
  // restore both the optimistic row and its pending state from the local
  // outbox rather than snapping back to the canonical title. Either honest
  // word for "still in the outbox" is accepted — `queued` while the drain has
  // not tried, `pending` once it has and is waiting on a connection; what must
  // never appear is a settled row or a denial.
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFirstParty(page, "Docs");
  await expect(
    page.getByRole("button", { name: `Select ${RENAMED_TITLE}` })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".kit-pending-chip").first()).toHaveText(
    /^(?:queued|pending)$/u
  );

  // Reconnect. The next session boot drains the outbox against the live
  // gateway; `executed` settlement removes the overlay in favour of the
  // canonical row, so the pending chip must clear and the rename must stand.
  await setHarnessControlOnline(page, true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFirstParty(page, "Docs");
  await expect(
    page.getByRole("button", { name: `Select ${RENAMED_TITLE}` })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".kit-pending-chip")).toHaveCount(0, {
    timeout: 60_000,
  });

  // Landed exactly once, on the document it named: replay must be idempotent,
  // not additive, and must never mint a second row beside the original.
  await expect
    .poll(() => driveIdsFor(page, RENAMED_TITLE), { timeout: 30_000 })
    .toEqual([documentId]);
  expect(await driveIdsFor(page, DOC_TITLE)).toEqual([]);

  // And the settled row is the vault's, not the overlay's: a fresh reload
  // (fresh in-memory session over the same gateway) still shows it settled.
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
