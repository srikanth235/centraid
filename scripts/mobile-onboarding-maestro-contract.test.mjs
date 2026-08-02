// Pins Maestro mobile journeys to the live scan-first onboarding UI (#676).
// Nightly red on run 30690725437 was assertVisible "Paste the one-line ticket"
// while the hierarchy only showed "Scan the QR code" / "Can't scan? Paste a
// code instead". This contract fails the PR lane if flows drift back to the
// obsolete paste-first copy without opening the secondary control first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const ONBOARDING = "apps/mobile/src/screens/Onboarding.tsx";
const HOME_LOADS = "tests/agent-e2e-mobile/flows/home-loads.mjs";
const HARNESS = "tests/agent-e2e-mobile/lib/harness.mjs";
const FIRST_RUN = "tests/agent-e2e-mobile/lib/first-run.mjs";

/** Drop // line comments so stale-copy bans do not trip on deliberate mentions. */
function stripLineComments(source) {
  return source.replace(/^\s*\/\/.*$/gmu, "");
}

test("Onboarding ships scan-first defaults with paste behind the secondary control", () => {
  const ui = read(ONBOARDING);
  // JSX uses Can&apos;t for the apostrophe; Maestro sees the rendered text.
  assert.match(ui, /Can&apos;t scan\? Paste a code instead/u);
  assert.match(ui, /Scan the QR code/u);
  assert.match(ui, /placeholder="Paste the one-line ticket"/u);
  assert.match(ui, /pairing \? "Connecting…" : "Connect"/u);
  assert.doesNotMatch(
    stripLineComments(ui),
    /Continue with pasted code/u,
    "product no longer uses the pre-scan-first primary label"
  );
});

test("home-loads asserts the scan-first hierarchy before opening paste", () => {
  const flow = read(HOME_LOADS);
  const firstRun = read("tests/agent-e2e-mobile/lib/first-run.mjs");
  // Connect wait lives in waitForOnboardingConnectCommands (ANR-safe helper).
  assert.match(firstRun, /Connect your gateway\./u);
  assert.match(flow, /waitForOnboardingConnectCommands/u);
  assert.match(flow, /openPastePathCommands/u);
  assert.match(flow, /Scan the QR code/u);
  assert.match(flow, /Can't scan\? Paste a code instead/u);
  assert.match(firstRun, /id:\s*"onboarding-paste"/u);
  assert.match(firstRun, /id:\s*"pairing-code-input"/u);
  // Destination-aware retries: keep tapping while paste control stays visible.
  assert.match(
    firstRun,
    /while:\s*\n\s*visible:\s*\n\s*id:\s*"onboarding-paste"/u
  );
  assert.doesNotMatch(
    stripLineComments(flow),
    /Continue with pasted code/u,
    "stale primary submit label must not return"
  );
});

test("configureGateway opens paste, then submits with live Connect label", () => {
  const harness = read(HARNESS);
  const firstRun = read(FIRST_RUN);
  // Paste/connect YAML lives in pasteAndConnectPairingTicketCommands (size cap).
  assert.match(harness, /pasteAndConnectPairingTicketCommands/u);
  assert.match(firstRun, /id:\s*"onboarding-paste"/u);
  assert.match(firstRun, /id:\s*"pairing-code-input"/u);
  assert.match(firstRun, /id:\s*"onboarding-connect"/u);
  // Recovery remounts paste (never a YAML eraseText:2000 step — kills Maestro).
  assert.match(firstRun, /Scan the QR code instead/u);
  assert.doesNotMatch(
    stripLineComments(firstRun),
    /^\s*- eraseText:\s*2000\s*$/mu
  );
  // Maestro YAML steps only — ban the stale label as a step value, not comments.
  assert.doesNotMatch(
    stripLineComments(firstRun),
    /(?:tapOn|assertVisible|text):\s*["']?Continue with pasted code/u,
    "harness must not tap/assert the pre-scan-first primary label"
  );
  const openPaste = firstRun.indexOf("onboarding-paste");
  const submit = firstRun.indexOf("onboarding-connect");
  assert.ok(openPaste >= 0 && submit > openPaste);
});

test("first-run dismisses Android system ANR overlays during onboarding wait", () => {
  const firstRun = read("tests/agent-e2e-mobile/lib/first-run.mjs");
  assert.match(firstRun, /isn't responding/u);
  assert.match(firstRun, /tapOn: "Wait"/u);
  assert.match(firstRun, /waitForOnboardingConnectCommands/u);
  const home = read(HOME_LOADS);
  assert.match(home, /waitForOnboardingConnectCommands/u);
  const harness = read(HARNESS);
  assert.match(harness, /waitForOnboardingConnectCommands/u);
});

test("paste secondary control is an accessibility button for XCUITest/Maestro", () => {
  const ui = read(ONBOARDING);
  // Label + role + testID must be on the Pressable that opens paste.
  assert.match(ui, /testID="onboarding-paste"/u);
  assert.match(
    ui,
    /accessibilityLabel="Can't scan\? Paste a code instead"[\s\S]{0,80}accessibilityRole="button"/u
  );
  assert.match(
    ui,
    /accessibilityLabel="Scan the QR code instead"[\s\S]{0,80}accessibilityRole="button"/u
  );
  const firstRun = read(FIRST_RUN);
  assert.match(firstRun, /id:\s*"onboarding-paste"/u);
  assert.match(firstRun, /openPastePathCommands/u);
});

test("dev entry suppresses LogBox overlay so Maestro can tap bottom controls", () => {
  const entry = read("apps/mobile/index.ts");
  assert.match(entry, /LogBox\.ignoreAllLogs\(true\)/u);
});

test("Connect submit blurs an empty codeRef before reading Maestro SET_TEXT", () => {
  const ui = read(ONBOARDING);
  assert.match(ui, /submitPaste/u);
  assert.match(ui, /codeInputRef\.current\?\.blur\(\)/u);
  assert.match(ui, /requestAnimationFrame/u);
});

test("pairing code field is focused by testID so lede text is not mistaken for the input", () => {
  const ui = read(ONBOARDING);
  assert.match(ui, /testID="pairing-code-input"/u);
  const firstRun = read(FIRST_RUN);
  assert.match(firstRun, /id:\s*"pairing-code-input"/u);
});

test("Connect submit is targeted by testID so Maestro does not tap the TextView", () => {
  const ui = read(ONBOARDING);
  assert.match(ui, /testID="onboarding-connect"/u);
  const firstRun = read(FIRST_RUN);
  assert.match(firstRun, /id:\s*"onboarding-connect"/u);
  // Must not use bare text Connect as the submit tap (matches non-clickable label).
  assert.doesNotMatch(
    stripLineComments(firstRun),
    /tapOn:\s*\n\s*text:\s*"\^Connect\$"/u
  );
});
