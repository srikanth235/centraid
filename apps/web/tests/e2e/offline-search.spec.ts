import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  installHarnessControlTransport,
  setHarnessControlOnline,
} from "./control-transport.js";

// Offline search over an unsettled row (#846 P4/P5). The outbox matcher MIRRORS
// FTS5: whitespace-only splitting makes `don't` ONE token, where re-splitting on
// word runs returns the decoy row FTS5 never would and marks only `don`.

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";
const CONTROL_SESSION = "web-e2e-control-session";

// Plain: punctuation arrives with the offline rename.
const PHRASE_UPLOAD = "offline-search-phrase.txt";
const DECOY_UPLOAD = "offline-search-decoy.txt";
const PHRASE_TITLE = "don't lose this.txt";
const DECOY_TITLE = "don is on the t list.txt";
const QUERY = "don't";

// The whole phrase, not `don`: P5.
const EXPECTED_MARK = "don't";

const SHOT = path.resolve(
  import.meta.dirname,
  "../../../../artifacts/e2e/ui-impact/offline-search-pending-phrase.png"
);

async function openFirstParty(page: Page, name: string): Promise<void> {
  // Re-click: the button can paint before its listener.
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
    const target = encodeURIComponent("/centraid/_vault/vaults");
    const response = await fetch(
      `${apiUrl}/centraid/_web/control?path=${target}`,
      { credentials: "include" }
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

async function driveIdFor(page: Page, title: string): Promise<string> {
  type Drive = { documents: Array<{ document_id: string; title: string }> };
  const drive = await page.evaluate(() =>
    window.centraid.read<Drive>({ query: "drive", input: {} })
  );
  const hits = drive.documents.filter((doc) => doc.title === title);
  expect(hits).toHaveLength(1);
  return hits[0]!.document_id;
}

async function uploadDoc(page: Page, name: string): Promise<string> {
  await page.locator('input[aria-label="Upload files"]').setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(`body of ${name}`, "utf8"),
  });
  await expect(
    page.getByRole("button", { name: `Select ${name}` })
  ).toBeVisible({ timeout: 30_000 });
  let documentId = "";
  await expect
    .poll(
      async () => {
        try {
          documentId = await driveIdFor(page, name);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  return documentId;
}

test("offline search reads a pending row's punctuation the way FTS5 does", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await connectPwa(page);
  await openFirstParty(page, "Docs");

  // Prove write-rail readiness BEFORE severing: an offline session never
  // bootstraps, and an early write throws instead of queueing. The probe is a
  // write the vault REFUSES, so no row is minted.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          try {
            const outcome = await window.centraid.write({
              action: "upload",
              input: { staged_sha: "0".repeat(64), title: "readiness-probe" },
              intentId: "offline-search-readiness-probe",
            });
            return outcome.status;
          } catch {
            return "replica-not-ready";
          }
        }),
      { timeout: 30_000 }
    )
    .not.toBe("replica-not-ready");

  const phraseId = await uploadDoc(page, PHRASE_UPLOAD);
  const decoyId = await uploadDoc(page, DECOY_UPLOAD);

  // Never remount Docs after the toggle: a fresh route walks the replica, which
  // cannot finish offline.
  await setHarnessControlOnline(page, false);
  // NEITHER WRITE IS AWAITED: a second offline write queues and paints but never
  // settles (write-rail defect, QUALITY.md); wait on the rendered rows.
  await page.evaluate(
    ({ renames }) => {
      for (const rename of renames) {
        window.centraid
          .write({
            action: "rename",
            input: { document_id: rename.id, title: rename.title },
            intentId: rename.intentId,
          })
          .catch(() => undefined);
      }
    },
    {
      renames: [
        {
          id: decoyId,
          title: DECOY_TITLE,
          intentId: "offline-search-decoy-rename",
        },
        {
          id: phraseId,
          title: PHRASE_TITLE,
          intentId: "offline-search-phrase-rename",
        },
      ],
    }
  );
  await expect(
    page.getByRole("button", { name: `Select ${PHRASE_TITLE}` })
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: `Select ${DECOY_TITLE}` })
  ).toBeVisible();

  // Marks live on the LIST row; the shelf has no toggle.
  await page.getByRole("button", { name: "List view" }).click();

  await page.getByRole("button", { name: "Search documents" }).click();
  const field = page.locator("#searchInput");
  await expect(field).toBeVisible();
  await field.fill(QUERY);

  // ONE row: FTS5 would not return the decoy, nor may the replica.
  await expect(
    page.getByRole("button", { name: `Select ${PHRASE_TITLE}` })
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: `Select ${DECOY_TITLE}` })
  ).toHaveCount(0);

  await expect(page.locator("mark").first()).toHaveText(EXPECTED_MARK);

  // Still unlanded: search over the OUTBOX, not a settled row.
  await expect(page.locator(".kit-pending-chip").first()).toHaveText(
    /^(?:queued|pending)$/u
  );

  await page.screenshot({ path: SHOT, fullPage: true });
});
