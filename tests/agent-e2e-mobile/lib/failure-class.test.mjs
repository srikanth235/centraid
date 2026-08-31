// Unit pins for the mobile flow failure classifier (#890).
//
// The classifier is the only thing standing between the run ledger and a suite
// that forgives itself, and it never runs on a device — so if it is not pinned
// here it is not pinned anywhere.
import { expect, test } from "vitest";

import {
  INFRASTRUCTURE_SIGNALS,
  classifyFailure,
  countMaestroAssertions,
} from "./failure-class.mjs";

test("every infrastructure signal is reachable through its own example", () => {
  expect(INFRASTRUCTURE_SIGNALS.length > 0).toBe(true);
  for (const signal of INFRASTRUCTURE_SIGNALS) {
    const verdict = classifyFailure({
      error: new Error(signal.example.text),
      assertionsRun: signal.example.assertionsRun,
    });
    expect(
      verdict.class,
      `${signal.id} did not classify as infrastructure`
    ).toBe("infrastructure");
    // First-match, not merely "some entry matched": a signal whose example is
    // swallowed by a looser entry above it is dead code that reads as covered.
    expect(
      verdict.signal,
      `${signal.id}'s example was claimed by ${verdict.signal}`
    ).toBe(signal.id);
    expect(verdict.reason.length > 0).toBe(true);
  }
});

test("no two signals share an id", () => {
  const ids = INFRASTRUCTURE_SIGNALS.map((signal) => signal.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("an assertVisible timeout with assertions run is a PRODUCT failure", () => {
  // The whole point of the module: this is what a regression looks like.
  const verdict = classifyFailure({
    error: new Error(
      'maestro test exited 1: Assertion is false: "All apps and places" is visible'
    ),
    assertionsRun: 4,
  });
  expect(verdict.class).toBe("product");
  expect(verdict.signal).toBe("assertion");
});

test("a chunk timeout with zero assertions run is INFRASTRUCTURE", () => {
  const verdict = classifyFailure({
    error: new Error("maestro test exceeded the 720000ms process timeout"),
    assertionsRun: 0,
  });
  expect(verdict.class).toBe("infrastructure");
  expect(verdict.signal).toBe("chunk-timeout-before-any-assertion");
});

test("the same chunk timeout AFTER an assertion ran is product", () => {
  // A flow that observed something and then wedged is a flow whose product
  // path is implicated; only "never got to look" earns the infra verdict.
  const verdict = classifyFailure({
    error: new Error("maestro test exceeded the 720000ms process timeout"),
    assertionsRun: 2,
  });
  expect(verdict.class).toBe("product");
});

test("an unknown error defaults to PRODUCT, never infrastructure", () => {
  const verdict = classifyFailure({
    error: new Error("TypeError: cannot read properties of undefined"),
    assertionsRun: 1,
  });
  expect(verdict.class).toBe("product");
  expect(verdict.signal).toBe("unclassified");
});

test("a non-zero maestro exit with zero assertions is still product", () => {
  // A regression on a flow's first assertion produces exactly this shape.
  // Classifying it infra would hide the class of defect the suite exists for.
  const verdict = classifyFailure({
    error: new Error("maestro --udid X test flow.yaml exited 1"),
    assertionsRun: 0,
  });
  expect(verdict.class).toBe("product");
});

test("stderr and stdout are searched alongside the thrown error", () => {
  const verdict = classifyFailure({
    error: new Error("maestro test exited 1"),
    stderr: "kAXErrorInvalidUIElement",
    assertionsRun: 5,
  });
  expect(verdict.signal).toBe("maestro-accessibility-element");
});

test("classifyFailure tolerates being called with nothing", () => {
  const verdict = classifyFailure();
  expect(verdict.class).toBe("product");
});

test("countMaestroAssertions counts only the observing directives", () => {
  const yaml = `appId: dev.centraid.mobile
---
- launchApp:
    clearState: true
- assertVisible: "Connect your gateway."
- tapOn: "Continue"
- extendedWaitUntil:
    visible: "All apps and places"
    timeout: 30000
- assertNotVisible: "Back to All"
- takeScreenshot: home
`;
  expect(countMaestroAssertions(yaml)).toBe(3);
});

test("countMaestroAssertions sees directives nested under runFlow", () => {
  const yaml = `- runFlow:
    when:
      visible: "Who's using this phone[?]"
    commands:
      - tapOn: "Your name"
      - assertVisible: "Nightly"
`;
  expect(countMaestroAssertions(yaml)).toBe(1);
});

test("countMaestroAssertions returns zero for an absent chunk", () => {
  expect(countMaestroAssertions(undefined)).toBe(0);
});
