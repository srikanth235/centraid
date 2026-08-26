// Web accessibility browser lane (#781, closing #587 D21): static scanners
// never see the live tree; axe-core (WCAG A/AA) runs in the shared Chromium
// harness against the cold connect screen and connected Home shell (#708).
// The mobile device-side lane is NOT this spec's claim (#781 follow-up).
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";

// WCAG A + AA — a testable standard, not axe's "best-practice" opinions.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** Render violations so the assertion failure is readable on its own. */
function describeViolations(
  violations: Array<{
    id: string;
    impact?: string | null;
    description: string;
    nodes: Array<{ target: Array<string | string[]> }>;
  }>
): string {
  return violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? "no impact"}): ` +
        `${violation.description} — ` +
        violation.nodes.map((node) => node.target.join(" ")).join(", ")
    )
    .join("\n");
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
  const vaultId = (control.body as { vaultId: string }).vaultId;

  await page.evaluate(
    ({ endpointId, endpointTicket, vault }) => {
      sessionStorage.removeItem("centraid.web.v1.connection");
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
  await expect(page.locator('nav[aria-label="Apps"]').first()).toBeVisible();
}

async function openFirstParty(page: Page, name: string): Promise<void> {
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
  await palette.locator("input").fill(name);
  await palette.getByRole("button").filter({ hasText: name }).first().click();
  await expect(page.getByTestId("inline-app-view")).toBeVisible();
  await expect(page.getByText(`Loading ${name}…`, { exact: true })).toHaveCount(
    0
  );
}

test("the cold connect screen has no WCAG A/AA violations", async ({
  page,
}) => {
  await page.goto("/");
  // Scan only once heading + textbox are up.
  await page.getByRole("textbox").first().waitFor();

  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    results.violations,
    describeViolations(results.violations)
  ).toStrictEqual([]);
});

test("the connected Home shell has no WCAG A/AA violations", async ({
  page,
}) => {
  // Same connected-session bootstrap as web-pwa.spec.ts.
  await connectPwa(page);

  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    results.violations,
    describeViolations(results.violations)
  ).toStrictEqual([]);
});

test("a first-party blueprint has no WCAG A/AA violations in its real renderer", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await connectPwa(page);
  await openFirstParty(page, "Docs");
  await expect(
    page.getByRole("heading", { name: "Docs" }).first()
  ).toBeVisible();

  // Inline routes, no served-app iframe (#799): plain scan reaches the real Docs tree.
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    results.violations,
    describeViolations(results.violations)
  ).toStrictEqual([]);
});
