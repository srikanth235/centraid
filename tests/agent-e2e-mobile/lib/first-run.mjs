// Reusable Maestro snippets for dismissing first-run interstitials that stand
// between a fresh launch and the screen a flow actually wants to assert on.
// Split out of harness.mjs, which sits against the 500-line repo cap; these are
// plain YAML-string constants with no edge back to the harness (same reason
// metro.mjs was extracted). Interpolated into a flow's `ctx.run(...)` YAML.

/**
 * The first keystroke on a freshly-booted simulator raises iOS's multilingual
 * keyboard onboarding sheet ("Type English and Dutch … Continue"). It covers the
 * bottom of the screen — including the tab bar — so every subsequent tap silently
 * lands on the sheet instead, and any keystrokes typed while it animates in are
 * swallowed (that is what corrupts text fields — see configureGateway). CI boots
 * a clean simulator each run, so it hits this every time. Dismiss it if it showed
 * up; do nothing if it didn't. Provoke it with a throwaway keystroke FIRST so its
 * appearance is deterministic rather than racing the real input.
 */
export const DISMISS_KEYBOARD_ONBOARDING = `- runFlow:
    when:
      visible: "^Continue$"
    commands:
      - tapOn: "^Continue$"
`;

/**
 * Cold Android emulators occasionally raise a system ANR sheet
 * ("Pixel Launcher isn't responding" / "System UI isn't responding") that
 * sits above the Centraid window. Maestro then only sees the sheet's
 * hierarchy, so waiters for onboarding copy time out even though the app
 * rendered correctly underneath (nightly re-run 30706136941). Tap "Wait"
 * so the app keeps running; never "Close app".
 */
export const DISMISS_SYSTEM_ANR = `- runFlow:
    when:
      visible: ".*isn't responding.*"
    commands:
      - tapOn: "Wait"
`;

/**
 * Wait for the scan-first onboarding heading after a clearState launch,
 * dismissing system ANR overlays between short polls so a stuck Pixel
 * Launcher dialog cannot burn the whole first-launch budget.
 *
 * @param {number} timeoutMs total wait budget (FIRST_LAUNCH_TIMEOUT_MS)
 */
export function waitForOnboardingConnectCommands(timeoutMs) {
  const pollMs = 5_000;
  const times = Math.max(1, Math.ceil(timeoutMs / pollMs));
  // Indent DISMISS_SYSTEM_ANR under the repeat commands list.
  const dismissInside = DISMISS_SYSTEM_ANR.split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `      ${line}`)
    .join("\n");
  return `${DISMISS_SYSTEM_ANR}- repeat:
    times: ${times}
    while:
      notVisible:
        text: "Connect your gateway."
    commands:
${dismissInside}
      - waitForAnimationToEnd:
          timeout: ${pollMs}
${DISMISS_SYSTEM_ANR}- extendedWaitUntil:
    visible:
      text: "Connect your gateway."
    timeout: ${pollMs}
`;
}

/**
 * Tap an animated React Native control without treating its press animation as
 * proof that navigation happened.
 *
 * Maestro's built-in retry covers a completely unchanged hierarchy. A
 * Pressable scale animation changes that hierarchy even when iOS ignores the
 * accessibility action, so retry a bounded two more times only while the
 * source control remains visible. Callers must still assert a destination
 * marker after this snippet; these retries never turn a missing navigation
 * into a pass.
 */
export function retryableTapCommands(selector, sourceSelector = selector) {
  const conditionalRetry = `- runFlow:
    when:
      visible: "${sourceSelector}"
    commands:
      - tapOn:
          text: "${selector}"
          retryTapIfNoChange: true`;
  return `- tapOn:
    text: "${selector}"
    retryTapIfNoChange: true
${conditionalRetry}
${conditionalRetry}`;
}

/**
 * Post-pair completion: profile form, Done → Enter Centraid, then the offline
 * capability wall ("Reconnect once") if the shell still needs a live info
 * probe, then Home ready. The wall is shell-only (App.tsx active={onboarded});
 * online probes also retry in-product (mobile-gateway-compatibility.ts).
 *
 * @param {string} homeReadyMarker HOME_READY_MARKER from the harness
 */
export function completeOnboardingCommands(homeReadyMarker) {
  const enterCentraid = retryableTapCommands("Enter Centraid")
    .split("\n")
    .map((line) => (line ? `      ${line}` : line))
    .join("\n");
  return `- runFlow:
    when:
      visible: "Who's using"
    commands:
      - tapOn: "Your name"
# e2e-lint-allow: unasserted-input — React Native TextInput values are not
# reliably Maestro-matchable; the personalized done heading below proves the
# submitted profile name end to end.
      - inputText: "Nightly"
      - hideKeyboard
      - tapOn: "Continue"
# Done heading is split across Text nodes; match the Enter Centraid control.
- runFlow:
    when:
      visible: "Enter Centraid"
    commands:
${enterCentraid}
# After Enter Centraid the shell may show the offline-capability wall until
# /_gateway/info succeeds over the tunnel. Tap Retry with gaps (Android
# 30711575336 stayed on the wall after two immediate taps).
- repeat:
    times: 8
    while:
      visible: "Reconnect once"
    commands:
      - tapOn: "Retry connection"
      - waitForAnimationToEnd:
          timeout: 5000
- extendedWaitUntil:
    visible: "${homeReadyMarker}"
    timeout: 120000
`;
}
