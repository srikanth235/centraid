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
  assert.match(flow, /Connect your gateway\./u);
  assert.match(flow, /Scan the QR code/u);
  assert.match(flow, /Can't scan\? Paste a code instead/u);
  const openPaste = flow.indexOf(`Can't scan? Paste a code instead`);
  const pasteField = flow.indexOf("Paste the one-line ticket");
  assert.ok(openPaste >= 0, "must open the paste path");
  assert.ok(
    pasteField > openPaste,
    "paste field only after opening paste path"
  );
  assert.doesNotMatch(
    stripLineComments(flow),
    /Continue with pasted code/u,
    "stale primary submit label must not return"
  );
});

test("configureGateway opens paste, then submits with live Connect label", () => {
  const harness = read(HARNESS);
  const configure = harness.slice(harness.indexOf("ctx.configureGateway"));
  assert.match(configure, /Can't scan\? Paste a code instead/u);
  assert.match(configure, /Paste the one-line ticket/u);
  assert.match(configure, /\^Connect\$/u);
  // Maestro YAML steps only — ban the stale label as a step value, not comments.
  assert.doesNotMatch(
    stripLineComments(configure),
    /(?:tapOn|assertVisible|text):\s*["']?Continue with pasted code/u,
    "harness must not tap/assert the pre-scan-first primary label"
  );
  const openPaste = configure.indexOf(`Can't scan? Paste a code instead`);
  const submit = configure.indexOf("^Connect$");
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
