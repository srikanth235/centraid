// Failure classification for mobile agent-e2e flows (#890). One pure function
// and one table; `lib/harness.mjs` calls it on every non-passing flow and
// `lib/run-ledger.mjs` stores the verdict beside the duration.
//
// WHY AN ASSERTION TIMEOUT IS NEVER INFRASTRUCTURE. An `assertVisible` giving up
// is the exact shape a real regression takes: the copy stopped rendering, the
// tap was a silent no-op, the replica read came back empty. Filing that under
// `infrastructure` is how a suite learns to forgive itself — the failure rate
// the budget ratchets read stays flat, the nightly reads "flaky again", and the
// one night the product genuinely broke is indistinguishable from the nights
// the simulator was slow. The opposite mistake costs a human reading a verdict
// and disagreeing, which is cheap. So `product` is the DEFAULT and
// `infrastructure` is reachable only through the enumerated signals below.
//
// A plain non-zero `maestro test` exit with zero assertions completed is
// PRODUCT, deliberately: that is precisely what a regression on a flow's FIRST
// assertion looks like. Only a process that never got to run its assertions —
// a chunk killed by the harness's own timeout, or a spawn that failed at the OS
// layer — earns the infrastructure verdict at zero assertions.

/** Every Maestro directive that carries an observation. `runFlow` counts these
 * per chunk so `assertionsRun` can distinguish "the flow never started" from
 * "the flow ran and disagreed with the product". */
const ASSERTION_DIRECTIVE_RE =
  /^\s*-\s+(?:assertVisible|assertNotVisible|extendedWaitUntil)\b/gmu;

export function countMaestroAssertions(yaml) {
  return String(yaml ?? "").match(ASSERTION_DIRECTIVE_RE)?.length ?? 0;
}

/** A signal matched on the failure text alone, whatever the assertion count. */
const onText = (id, pattern, reason, example) => ({
  id,
  reason,
  example: { text: example, assertionsRun: 3 },
  matches: ({ text }) => pattern.test(text),
});

/**
 * The infrastructure signals, in match order. Every entry carries the `example`
 * it was written from — the observed line, not a paraphrase — because a signal
 * nobody has ever seen is a signal that classifies nothing, and
 * `failure-class.test.mjs` asserts each entry is the FIRST match for its own
 * example. That is what proves no entry is dead or shadowed by a looser one
 * above it. Add a signal only with the line that motivated it.
 */
export const INFRASTRUCTURE_SIGNALS = [
  // FIRST, and matched on the screen digest rather than the exit text. An
  // Android ANR/crash dialog is a system window with NO app content, so every
  // `visible` under it misses whatever the app drew — the assertion did not
  // look at the product and disagree, it never reached the product at all.
  // That is the one shape where a `product` verdict would be a fabrication in
  // the same sense the header describes, and `id:aerr_*` is unforgeable: those
  // are AOSP `app_error.xml` handles, never app copy.
  //
  // This is a BACKSTOP for the suppression in
  // apps/mobile/scripts/android-emulator-install.sh, not a substitute — the
  // dialog is supposed to be hidden, and a retry that quietly papers over a
  // launcher ANR every run is the failure-rate blindness this file exists to
  // prevent. It fires so a run reports the environment honestly and can be
  // retried; the digest line lands in the ledger reason either way.
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
  // The three below are the harness's OWN preconditions, quoted from the throw
  // sites in `setup()`. They fail before a flow body ever runs, so no product
  // claim was ever exercised — a product verdict here would be a fabrication.
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

/**
 * THE THIRD CLASS: the JOURNEY itself is broken (#915 Wave 2, from #870).
 *
 * `flows/share-intent-in.mjs` referenced `shQuote` and never imported it. On the
 * 2026-09-01 nightly (run 33498199941) the flow threw
 * `ReferenceError: shQuote is not defined` at its own line 75, AFTER six
 * assertions had passed — so nothing above matched, the default fired, and the
 * ledger recorded `product`. The run therefore said the app was broken. The app
 * was fine; the journey was.
 *
 * A flow-script crash is neither. It is not `infrastructure` — nothing flaked,
 * and a retry would reproduce it exactly, which is why `retry-policy.mjs`
 * retries only `infrastructure` and this class is silently correct there. And it
 * is not `product` — no claim was ever exercised, so counting it against the
 * lane's pass rate makes the phone look worse than it is and the journey look
 * fine, which is the wrong end of both.
 *
 * Matched on the ERROR TYPE plus a stack frame inside this tree, so a
 * `TypeError` the app raised through Maestro cannot borrow the class: Maestro
 * failures arrive as `Error: maestro … exited 1` with no `tests/agent-e2e-mobile`
 * frame at all.
 */
const FLOW_CRASH_RE = /^(?:ReferenceError|TypeError|SyntaxError|RangeError):/mu;
// `.test.mjs` is excluded on purpose: the spec for this very function builds
// errors whose stacks name the spec file, and matching those would make the
// classifier agree with itself for the wrong reason.
const FLOW_FRAME_RE =
  /tests\/agent-e2e-mobile\/(?:flows|lib)\/[\w.-]+(?<!\.test)\.mjs/u;

/** Maestro's vocabulary for "I looked and the product disagreed". Naming it
 * buys a readable `signal` in the ledger; it changes no verdict, because
 * everything that reaches this point is `product` either way. */
const PRODUCT_ASSERTION_RE =
  /Assertion is false|Element not found|not visible|did not become visible/iu;

/**
 * Classify one flow failure. `stderr`/`stdout` are accepted because a future
 * caller may capture them; `runFlow` today spawns Maestro with inherited stdio
 * and so passes only the thrown error, whose message carries the exit code and
 * the harness's own precondition text.
 *
 * @returns {{class: "infrastructure"|"product", reason: string, signal: string}}
 *   The verdict the run ledger stores; `signal` names the matched entry so a
 *   summary can group failures without re-parsing the prose reason.
 */
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
