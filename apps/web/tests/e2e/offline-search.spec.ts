import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  installHarnessControlTransport,
  setHarnessControlOnline,
} from "./control-transport.js";

// Offline search over an unsettled row (#846 P4/P5). The replica answers Docs'
// `search` query from its own FTS index plus a bounded matcher for rows that
// are still in the outbox, and that matcher is a MIRROR of the gateway's FTS5
// grammar — not an approximation of it. Two divergences are visible to a
// member rather than merely wrong in the abstract:
//
//  - the token stream. The gateway splits on whitespace only, so `don't` is ONE
//    token compiling to one quoted prefix phrase. Re-splitting on Unicode word
//    runs makes it two independent terms — offline search then returns rows the
//    same query would never return online, and applies the 16-token bound to a
//    different stream on top of that.
//  - the highlight. With the second half of that phrase as a separate term,
//    the marks land on `don` and stop, cutting the hit in half on screen.
//
// This journey pins both through the production UI: the Docs Search shelf, its
// own snippet marks, over two pending rows chosen so that the divergence is the
// difference between them. The decoy holds `don` and a later word starting `t`,
// adjacent to nothing — a re-splitting matcher returns it, FTS5 never would.
//
// The renames are issued through `window.centraid.write` for the same reason
// offline-reconnect.spec.ts does it: Docs' rename affordances live in the
// sidebar the inline seat hides, so a UI-driven rename would spend the journey
// proving navigation. Everything observed after the write — the shelf, the
// rows, the marks, the pending chips — is the production UI's.

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";
const CONTROL_SESSION = "web-e2e-control-session";

// The uploaded titles are deliberately plain: the punctuation arrives with the
// OFFLINE rename, so the phrase under test only ever exists as a pending value.
const PHRASE_UPLOAD = "offline-search-phrase.txt";
const DECOY_UPLOAD = "offline-search-decoy.txt";
const PHRASE_TITLE = "don't lose this.txt";
const DECOY_TITLE = "don is on the t list.txt";
const QUERY = "don't";

// The mark spans the WHOLE phrase — `don't`, not `don`. This single string is
// the P5 regression, rendered.
const EXPECTED_MARK = "don't";

const SHOT = path.resolve(
  import.meta.dirname,
  "../../../../artifacts/e2e/ui-impact/offline-search-pending-phrase.png"
);

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

/** The document id the drive read carries for a given exact title. */
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
  // Two uploads have to settle canonically BEFORE the gateway is severed, so
  // this journey carries a longer budget than the single-row reconnect one.
  test.setTimeout(300_000);
  await connectPwa(page);
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

  // Sever the gateway, then title both rows offline. Do not remount Docs after
  // the toggle: opening the route again starts a replica walk that cannot
  // finish offline, and the write would throw not-bootstrapped instead of
  // queueing. Shelf navigation below is in-app and keeps this session.
  await setHarnessControlOnline(page, false);
  // BOTH WRITES ARE ISSUED, ONLY THE FIRST IS AWAITED — deliberately, and not
  // because the second is optional. A second offline write in the same session
  // queued and painted, but its promise never settles: whichever rename goes
  // second reports `never-settled` against a 30s race while its optimistic row
  // is on screen the whole time (measured both ways round — it follows the
  // ORDER, not the row). That is a live defect in the write rail, filed in
  // QUALITY.md, out of scope for #846's search fix; this journey is about what
  // search does with the pending rows, so it takes them from the UI, which is
  // truthful, rather than from a promise that is not. NEITHER WRITE IS AWAITED:
  // the assertions below are outcome polls over the rendered rows, which is
  // what the journey actually waits on.
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

  // The snippet line is the LIST row's (components/List.tsx); the grid card
  // carries no marks to read. The view pair is the member's own choice and it
  // survives into the shelf, so make it here, on the drive, where the toggle
  // lives — the Search shelf withholds it.
  await page.getByRole("button", { name: "List view" }).click();

  // Search is a shelf, reached from the app bar's own Search control — the
  // field exists nowhere else, so this navigation is part of the journey
  // rather than scaffolding around it.
  await page.getByRole("button", { name: "Search documents" }).click();
  const field = page.locator("#searchInput");
  await expect(field).toBeVisible();
  await field.fill(QUERY);

  // ONE row, and it is the row that actually holds the phrase. The decoy holds
  // both halves of it and holds them apart; FTS5 would not return that row
  // online, so the replica must not return it offline.
  await expect(
    page.getByRole("button", { name: `Select ${PHRASE_TITLE}` })
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: `Select ${DECOY_TITLE}` })
  ).toHaveCount(0);

  // The marks span the whole phrase. `don` alone here is P5, unfixed.
  await expect(page.locator("mark").first()).toHaveText(EXPECTED_MARK);

  // And the row still says it has not landed: this is offline search over the
  // OUTBOX, not over a settled vault row that happens to be readable.
  await expect(page.locator(".kit-pending-chip").first()).toHaveText(
    /^(?:queued|pending)$/u
  );

  await page.screenshot({ path: SHOT, fullPage: true });
});
