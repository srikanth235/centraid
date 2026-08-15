// Web accessibility browser lane (#781, closing a #587 D21 gap).
//
// The repo's only accessibility owners before this were static scanners —
// scripts/accessibility-contract.test.mjs greps source for pinned aria
// attributes and scripts/lint-aria-labels.mjs walks JSX text — so no gate ever
// asked a real browser what the accessibility tree actually contains. This
// spec runs axe-core (WCAG 2.0/2.1 A + AA rulesets) inside the same Chromium
// harness the other web e2e journeys use, against the two highest-traffic web
// surfaces: the cold connect screen (the first thing every web user sees) and
// the connected Home shell (the springboard every session lands on, #708).
//
// A violation fails with axe's own description, impact, and the offending
// selectors, so the failure names what broke without a debugger. The mobile
// device-side lane (RN accessibility tree on a booted simulator) is NOT this
// spec's claim and stays tracked in the #781 follow-up issue.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { installHarnessControlTransport } from "./control-transport.js";

const API_URL = "http://127.0.0.1:48765";
const ADMIN_TOKEN = "centraid-web-e2e-token";
const GATEWAY_ENDPOINT_ID = "web-e2e-gateway";
const GATEWAY_ENDPOINT_TICKET = "web-e2e-control-transport";

// WCAG A + AA — the axe tag set that maps to a testable standard, rather than
// axe's "best-practice" opinions, which would make the gate assert taste.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** Render axe violations so the assertion failure is readable on its own. */
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

test("the cold connect screen has no WCAG A/AA violations", async ({
  page,
}) => {
  await page.goto("/");
  // The connect heading + pairing-ticket textbox are the cold screen's whole
  // contract; scan only once it is actually the screen under test.
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
  // Same connected-session bootstrap as web-pwa.spec.ts: cookie control
  // session from the mock gateway, then a stored connection + completed
  // onboarding so the reload lands on Home rather than the connect screen.
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
  // Home is ready when the Apps navigation is on screen (#708 springboard).
  await expect(page.locator('nav[aria-label="Apps"]').first()).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    // The sandboxed app iframe is a separate document owned by the app under
    // test, not by the shell; scanning it here would blame the shell's cell
    // for a fixture app's markup.
    .exclude('iframe[title="app"]')
    .analyze();
  expect(
    results.violations,
    describeViolations(results.violations)
  ).toStrictEqual([]);
});
