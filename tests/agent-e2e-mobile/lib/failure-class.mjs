const ASSERTION_DIRECTIVE_RE =
  /^\s*-\s+(?:assertVisible|assertNotVisible|extendedWaitUntil)\b/gmu;

export function countMaestroAssertions(yaml) {
  return String(yaml ?? "").match(ASSERTION_DIRECTIVE_RE)?.length ?? 0;
}

const onText = (id, pattern, reason, example) => ({
  id,
  reason,
  example: { text: example, assertionsRun: 3 },
  matches: ({ text }) => pattern.test(text),
});

export const INFRASTRUCTURE_SIGNALS = [
  onText(
    "android-system-error-dialog",
    /\bid:aerr_(?:close|wait|restart|report)\b/u,
    "an Android ANR/crash dialog covered the app, so the assertion queried a system window with no app content",
    'the screen carried: id:alertTitle "Pixel Launcher isn\'t responding" id:aerr_close "Close app" id:aerr_wait "Wait"'
  ),
  onText(
    "maestro-driver-disconnect",
    /Failed to connect to \/127\.0\.0\.1:7001/u,
    "Maestro's iOS driver dropped its connection to the device",
    "maestro test exited 1: Failed to connect to /127.0.0.1:7001"
  ),
  onText(
    "maestro-accessibility-element",
    /kAXErrorInvalidUIElement/u,
    "the XCUITest accessibility tree handed Maestro a stale element",
    "java.lang.RuntimeException: kAXErrorInvalidUIElement"
  ),
  onText(
    "connection-refused",
    /Connection refused|ECONNREFUSED/u,
    "a process the flow depends on refused the connection",
    "fetch failed: connect ECONNREFUSED 127.0.0.1:18789"
  ),
  onText(
    "device-not-found",
    /device not found/iu,
    "the udid the harness resolved is no longer attached",
    "adb: device not found"
  ),
  onText(
    "device-offline",
    /device offline/iu,
    "the emulator is attached but not serving adb",
    "adb: device offline"
  ),
  onText(
    "no-booted-device",
    /No booted iOS Simulator or Android emulator/u,
    "setup() found no booted device to drive",
    "Error: No booted iOS Simulator or Android emulator. For iOS: open Simulator.app"
  ),
  onText(
    "app-not-installed",
    /not installed on (?:ios|android) device/iu,
    "the dev build is missing from the resolved device",
    "Error: dev.centraid.mobile not installed on ios device 1234-ABCD."
  ),
  onText(
    "metro-unreachable",
    /Metro bundler not reachable/u,
    "Metro never came up, so the dev client had no JS bundle to fetch",
    "Error: Metro bundler not reachable at http://127.0.0.1:8081 after the bounded readiness wait."
  ),
  {
    id: "chunk-timeout-before-any-assertion",
    reason:
      "the harness killed a wedged Maestro chunk before it completed a single assertion",
    example: {
      text: "Error: maestro --udid X test flow.yaml exceeded the 720000ms process timeout",
      assertionsRun: 0,
    },
    matches: ({ text, assertionsRun }) =>
      assertionsRun === 0 && /exceeded the \d+ms process timeout/u.test(text),
  },
  {
    id: "process-death-before-any-assertion",
    reason:
      "the Maestro process died at the OS layer before any assertion could run",
    example: { text: "Error: spawn maestro ENOENT", assertionsRun: 0 },
    matches: ({ text, assertionsRun }) =>
      assertionsRun === 0 && /\b(?:ENOENT|EACCES|EPERM|ENOMEM)\b/u.test(text),
  },
];

const FLOW_CRASH_RE = /^(?:ReferenceError|TypeError|SyntaxError|RangeError):/mu;
const FLOW_FRAME_RE =
  /tests\/agent-e2e-mobile\/(?:flows|lib)\/[\w.-]+(?<!\.test)\.mjs/u;

const PRODUCT_ASSERTION_RE =
  /Assertion is false|Element not found|not visible|did not become visible/iu;

export function classifyFailure({
  error,
  stderr = "",
  stdout = "",
  assertionsRun = 0,
} = {}) {
  const text = [
    error?.message,
    error?.stack,
    String(error ?? ""),
    stderr,
    stdout,
  ]
    .filter(Boolean)
    .join("\n");
  const completed = Number.isFinite(assertionsRun) ? Number(assertionsRun) : 0;

  for (const signal of INFRASTRUCTURE_SIGNALS) {
    if (signal.matches({ text, assertionsRun: completed })) {
      return {
        class: "infrastructure",
        reason: signal.reason,
        signal: signal.id,
      };
    }
  }

  if (FLOW_CRASH_RE.test(text) && FLOW_FRAME_RE.test(text)) {
    const named = FLOW_CRASH_RE.exec(text)[0].replace(/:$/u, "");
    return {
      class: "harness",
      reason:
        `the journey's own script threw ${named} after ${completed} completed assertion(s) — ` +
        `this is a defect in the flow, not in the product, and no claim was exercised`,
      signal: "flow-crash",
    };
  }

  if (PRODUCT_ASSERTION_RE.test(text)) {
    return {
      class: "product",
      reason: `an assertion failed after ${completed} completed assertion(s)`,
      signal: "assertion",
    };
  }
  return {
    class: "product",
    reason: `unrecognized failure after ${completed} completed assertion(s); classified product by default`,
    signal: "unclassified",
  };
}
