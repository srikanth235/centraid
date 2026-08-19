import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";

// Docs north-star journey (byte-bearing, docs/apps/docs-scenarios.md, #781):
// a member uploads a real file through the visible product control, the
// bytes stage into the gateway CAS through the authed blob door, and both
// the document row and its exact bytes survive a full PWA reload. The
// harness gateway, vault, staging routes, and inline Docs bundle are all
// real; only the iroh wire is adapted (control-transport.ts).

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";
const CONTROL_SESSION = "web-e2e-control-session";

const DOC_TITLE = "lease-notes.txt";
const DOC_BODY =
  "Lease renewal notes: the deposit clause moved to §4.\n\nKeep the signed copy with the 2026 tax folder.";

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

test("Docs uploads a real file and its bytes survive a PWA reload", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await connectPwa(page);
  await openFirstParty(page, "Docs");
  // The inline replica session bootstraps asynchronously after the app
  // mounts; a write issued before that throws ReplicaRebootstrapRequired and
  // the one-shot UI upload would land in the "could not read" failure arm.
  // Prove write readiness first with a probe the vault deterministically
  // REFUSES (an unstaged sha fails add_document's staged_or_owned
  // precondition): any accepted status — the refusal, or the durable queue's
  // own in-flight — means the intent rail is up without minting any document.
  // Same readiness-poll shape as the pending-overlay journey's writes.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          try {
            const outcome = await window.centraid.write({
              action: "upload",
              input: { staged_sha: "0".repeat(64), title: "readiness-probe" },
              intentId: "docs-e2e-readiness-probe",
            });
            return outcome.status;
          } catch {
            return "replica-not-ready";
          }
        }),
      { timeout: 30_000 }
    )
    .not.toBe("replica-not-ready");

  // Upload through the product's own control: the hidden file input the
  // toolbar Upload button drives. Staging (sha preflight + authed POST to
  // /_vault/blobs) and core.add_document both run for real.
  await page.locator('input[aria-label="Upload files"]').setInputFiles({
    name: DOC_TITLE,
    mimeType: "text/plain",
    buffer: Buffer.from(DOC_BODY, "utf8"),
  });
  await expect(
    page.getByRole("button", { name: `Select ${DOC_TITLE}` })
  ).toBeVisible({ timeout: 30_000 });

  // The document is a vault row, not browser state: it must come back after
  // a full reload of the PWA shell.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('nav[aria-label="Apps"]').waitFor({ state: "visible" });
  await openFirstParty(page, "Docs");
  await expect(
    page.getByRole("button", { name: `Select ${DOC_TITLE}` })
  ).toBeVisible({ timeout: 30_000 });

  // Byte-bearing proof: the exact uploaded bytes come back down on demand
  // through the authed product transport — CAS staging really deduplicated
  // into a canonical content item this document points at.
  type DriveDoc = {
    title: string;
    content_uri?: string | null;
    byte_size?: number | null;
  };
  const drive = await page.evaluate(() =>
    window.centraid.read<{ documents: DriveDoc[] }>({
      query: "drive",
      input: {},
    })
  );
  const uploaded = drive.documents.filter(
    (d: DriveDoc) => d.title === DOC_TITLE
  );
  // Exactly one document: re-running the upload path must not have minted two.
  expect(uploaded).toHaveLength(1);
  expect(uploaded[0]!.byte_size).toBe(Buffer.byteLength(DOC_BODY, "utf8"));
  const contentUri = uploaded[0]!.content_uri;
  expect(contentUri).toEqual(expect.any(String));
  const roundTrip = await page.evaluate(async (uri) => {
    if (uri.startsWith("data:")) {
      const response = await fetch(uri).catch(() => null);
      if (response) return response.text();
      // The app CSP can refuse fetching data: URIs — decode inline instead.
      const comma = uri.indexOf(",");
      const meta = uri.slice(0, comma);
      const payload = uri.slice(comma + 1);
      return meta.includes("base64")
        ? atob(payload)
        : decodeURIComponent(payload);
    }
    const transport = (
      window as unknown as {
        CentraidIroh: { fetch: (pathname: string) => Promise<Response> };
      }
    ).CentraidIroh;
    const response = await transport.fetch(uri);
    return response.text();
  }, contentUri!);
  expect(roundTrip).toBe(DOC_BODY);

  // Opening the document lands on the Quick look stage — Docs' only viewer
  // since #819 deleted the reading route — and paints the exact body through
  // the inline shell's authenticated blob primitive.
  await page
    .getByRole("button", { name: `Preview ${DOC_TITLE}` })
    .first()
    .click();
  const stage = page.getByRole("dialog", { name: "Quick look" });
  await expect(stage).toBeVisible({ timeout: 30_000 });
  const reading = stage.getByRole("article", { name: DOC_TITLE });
  await expect(reading).toBeVisible();
  await expect(reading.getByRole("heading", { name: DOC_TITLE })).toBeVisible();
  await expect(reading.getByText(DOC_BODY.split("\n\n")[0]!)).toBeVisible();
  await expect(reading.getByText(DOC_BODY.split("\n\n")[1]!)).toBeVisible();
  const evidenceDir = path.join(
    import.meta.dirname,
    "../../../../artifacts/e2e/ui-impact"
  );
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, "issue-822-docs-drive.png"),
    fullPage: true,
  });
});
