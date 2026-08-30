// A `sensitive` Maestro chunk runs quiet and its debug directory is discarded,
// so the redacted JUnit failure text is the ONLY account of which command
// failed. These tests pin both halves of that bargain: the command description
// survives, the capability does not.
import { expect, test } from "vitest";

import { extractJunitFailures } from "./harness.mjs";

test("names the Maestro command that failed", () => {
  const xml = `<testsuite>
  <testcase name="configure-gateway">
    <failure message="Element not found: Extended wait until &quot;Connect your gateway.&quot; is visible"/>
  </testcase>
</testsuite>`;
  expect(extractJunitFailures(xml)).toBe(
    'Element not found: Extended wait until "Connect your gateway." is visible'
  );
});

test("joins every failure in the report", () => {
  const xml = `<testsuite>
  <testcase><failure message="first broke"/></testcase>
  <testcase><error message="second broke"/></testcase>
</testsuite>`;
  expect(extractJunitFailures(xml)).toBe("first broke | second broke");
});

test("keeps an element body when there is no message attribute", () => {
  const xml = `<testsuite><testcase><failure>assertion
    text spanning lines</failure></testcase></testsuite>`;
  expect(extractJunitFailures(xml)).toBe("assertion text spanning lines");
});

test("redacts a pairing capability that reaches the report", () => {
  const ticket = `centraid1${"a".repeat(200)}`;
  const detail = extractJunitFailures(
    `<testsuite><testcase><failure message="inputText ${ticket} failed"/></testcase></testsuite>`
  );
  expect(detail).not.toContain(ticket);
  expect(detail).toContain("[REDACTED_CAPABILITY]");
});

test("redacts a bearer token that reaches the report", () => {
  const detail = extractJunitFailures(
    '<testsuite><testcase><failure message="GET failed: Bearer sk-live-abc123"/></testcase></testsuite>'
  );
  expect(detail).not.toContain("sk-live-abc123");
  expect(detail).toContain("Bearer [REDACTED]");
});

test("returns an empty string for a clean report", () => {
  expect(
    extractJunitFailures('<testsuite><testcase name="ok"/></testsuite>')
  ).toBe("");
});
