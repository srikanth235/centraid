import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { connectPwa } from "./connect.js";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

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
  await connectPwa(page);

  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(
    results.violations,
    describeViolations(results.violations)
  ).toStrictEqual([]);
});

const FIRST_PARTY_APPS = [
  "Docs",
  "Notes",
  "Tasks",
  "Agenda",
  "People",
  "Photos",
  "Tally",
  "Locker",
] as const;

for (const app of FIRST_PARTY_APPS) {
  test(`${app} has no WCAG A/AA violations in its real renderer`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await connectPwa(page);
    await openFirstParty(page, app);
    const results = await new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .analyze();
    expect(
      results.violations,
      describeViolations(results.violations)
    ).toStrictEqual([]);
  });
}
