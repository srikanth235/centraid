// Reusable Maestro snippets for dismissing first-run interstitials that stand
// between a fresh launch and the screen a flow actually wants to assert on.
// Split out of harness.mjs, which sits against the 500-line repo cap; these are
// plain YAML-string constants with no edge back to the harness (same reason
// metro.mjs was extracted). Interpolated into a flow's `ctx.run(...)` YAML.

/**
 * The first keystroke on a freshly-booted simulator raises iOS's multilingual
 * keyboard onboarding sheet ("Type English and Dutch … Continue"). It covers the
 * bottom of the screen — including the dock — so every subsequent tap silently
 * lands on the sheet instead, and any keystrokes typed while it animates in are
 * swallowed (that is what corrupts text fields — see configureGateway). CI boots
 * a clean simulator each run, so it hits this every time. Dismiss it if it showed
 * up; do nothing if it didn't. Provoke it with a throwaway keystroke FIRST so its
 * appearance is deterministic rather than racing the real input.
 */
export const DISMISS_KEYBOARD_ONBOARDING = `- runFlow:
    when:
      visible: "Continue"
    commands:
      - tapOn: "Continue"
`;

/**
 * First-run onboarding (`src/screens/Onboarding.tsx`) renders ahead of the
 * springboard whenever `profile.onboarded` is false — and `launchApp: {
 * clearState: true}` wipes that AsyncStorage flag, so a fresh launch always
 * lands on "Connect your gateway", not Home. Production has no escape hatch
 * (founding ceremony is mandatory); debug builds expose **"Skip for now"** so
 * e2e and local simulators can reach Home, then configure a tokenless
 * loopback gateway via Settings → Advanced (the mobile CI gateway path).
 *
 * Returns the YAML to WAIT for that button and tap it — the wait matters: a
 * point-in-time `runFlow: when visible` fires the instant `launchApp` returns,
 * before the JS bundle has painted onboarding, so it saw nothing and no-op'd.
 * `timeoutMs` is the caller's first-launch budget (bundle fetch + render).
 * Applies on **both** platforms: iOS clearState also lands on onboarding now
 * that the founding plane removed any persisted skip path.
 */
export function skipOnboarding(_platform, timeoutMs) {
  return `- extendedWaitUntil:
    visible: "Skip for now"
    timeout: ${timeoutMs}
- scrollUntilVisible:
    element:
      text: "Skip for now"
    direction: DOWN
    visibilityPercentage: 100
- tapOn: "Skip for now"
# Prove the ceremony screen is gone before waiting on Home — a silent miss on
# the Skip press used to leave us on "Connect your gateway" for the full
# YOUR APPS timeout (CI runs 30260560923 / 30260563070).
- extendedWaitUntil:
    notVisible: "Connect your gateway"
    timeout: 30000
`;
}

/** Stable first-paint marker on the springboard Home (issue #498). */
export const HOME_RAIL_LABEL = 'YOUR APPS';

/**
 * Maestro YAML body for `ctx.configureGateway` — clearState → skip onboarding
 * → Settings → Advanced → type URL (and optional token) → Save → Home.
 * Kept here so lib/harness.mjs stays under the 500-line repo-hygiene cap.
 */
export function configureGatewayYaml({
  appId,
  platform,
  firstLaunchTimeoutMs,
  gatewayUrl,
  gatewayToken = '',
}) {
  const tokenSteps = gatewayToken
    ? `- tapOn: "paste token here"
# e2e-lint-allow: unasserted-input — a bearer token is a secret; the field masks
# it and it is never rendered back, so there is no value to assertVisible on.
- inputText: ${JSON.stringify(gatewayToken)}
${DISMISS_KEYBOARD_ONBOARDING}`
    : '';
  return `appId: ${appId}
---
- launchApp:
    clearState: true
${skipOnboarding(platform, firstLaunchTimeoutMs)}- extendedWaitUntil:
    visible:
      text: "${HOME_RAIL_LABEL}"
    timeout: ${firstLaunchTimeoutMs}
- tapOn: "Settings"
# LogBox toast steals Advanced taps (CI run 30264498210).
- runFlow:
    when:
      visible: "Open debugger to view warnings"
    commands:
      - tapOn:
          point: "92%,96%"
- extendedWaitUntil:
    visible: "Desktop link"
    timeout: 15000
- scrollUntilVisible:
    element:
      text: "Gateway connection"
    direction: DOWN
    visibilityPercentage: 100
- tapOn: "Gateway connection"
- scrollUntilVisible:
    element:
      text: "Gateway URL"
    direction: DOWN
    visibilityPercentage: 100
    timeout: 15000
- extendedWaitUntil:
    visible: "Gateway URL"
    timeout: 10000
- tapOn:
    text: "http://127.0.0.1:18789"
    below: "Dev fallback for simulators.*"
# e2e-lint-allow: unasserted-input — throwaway keystroke to provoke the iOS
# keyboard onboarding sheet; erased immediately below.
- inputText: "x"
${DISMISS_KEYBOARD_ONBOARDING}- eraseText
- inputText: ${JSON.stringify(gatewayUrl)}
- assertVisible:
    text: ${JSON.stringify(gatewayUrl)}
    below: "Dev fallback for simulators.*"
${tokenSteps}- hideKeyboard
- tapOn: "Save"
- extendedWaitUntil:
    visible: "${HOME_RAIL_LABEL}"
    timeout: 30000
- assertNotVisible: "Connect your computer. Pair desktop"
`;
}
