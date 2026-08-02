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
 * Open the scan-first paste path and wait for the pairing field.
 *
 * A single `tapOn` with `retryTapIfNoChange` can COMPLETE on iOS when some
 * other hierarchy change settles (LogBox / layout) without flipping
 * `showPaste` (30716166878). Keep tapping while the paste control itself is
 * still visible, then wait for the field testID.
 */
export function openPastePathCommands() {
  return `# Open paste by testID — text taps can COMPLETE without flipping showPaste
# on iOS (30711575336) even with accessibilityRole=button.
- tapOn:
    id: "onboarding-paste"
    retryTapIfNoChange: true
- repeat:
    times: 6
    while:
      visible:
        id: "onboarding-paste"
    commands:
      - tapOn:
          id: "onboarding-paste"
          retryTapIfNoChange: true
      - waitForAnimationToEnd:
          timeout: 1000
# Wait for the paste field by testID — lede/placeholder text is not a reliable
# XCUITest match on iOS (30713590856).
- extendedWaitUntil:
    visible:
      id: "pairing-code-input"
    timeout: 15000
`;
}

/**
 * After onboarding is showing "Connect your gateway.", open paste, enter the
 * MAESTRO_PAIRING_TICKET env, submit Connect, and wait for profile / Done /
 * Home (or a visible pairing error). Extracted from harness.mjs for the
 * file-size cap and so recovery comments stay next to the YAML they describe.
 *
 * @param {string} homeReadyMarker HOME_READY_MARKER from the harness
 * @param {string} dismissKeyboardOnboarding DISMISS_KEYBOARD_ONBOARDING or ""
 */
export function pasteAndConnectPairingTicketCommands(
  homeReadyMarker,
  dismissKeyboardOnboarding = DISMISS_KEYBOARD_ONBOARDING
) {
  // Maestro textRegex is full-string (docs: shorthand = exact). Android merges
  // the profile h1 into "Who's using this phone?" — bare "Who's using" never
  // matches (30742508620), so remount fired after a successful pair and died
  // tapping onboarding-scan-instead on the profile screen. Trailing .? so
  // "Paste a pairing ticket first." matches. Do NOT use \. inside the
  // double-quoted YAML value (BAD_DQ_ESCAPE → configure exits ~3s, 30735481514).
  const progressOrError =
    "Connecting.?|Who.?s using.*|Enter Centraid|" +
    homeReadyMarker +
    "|Paste a pairing ticket first.?|not a Centraid pairing|expired|Could not reach";
  const remountBody = [
    `- tapOn:`,
    `    id: "onboarding-scan-instead"`,
    `    retryTapIfNoChange: true`,
    ...openPastePathCommands()
      .split("\n")
      .filter((line) => line.length > 0),
    `- tapOn:`,
    `    id: "pairing-code-input"`,
    `# e2e-lint-allow: unasserted-input — retype after remount; redemption is the check.`,
    `- inputText: \${MAESTRO_PAIRING_TICKET}`,
    `- hideKeyboard`,
    `- waitForAnimationToEnd:`,
    `    timeout: 2000`,
    `- scrollUntilVisible:`,
    `      element:`,
    `        id: "onboarding-connect"`,
    `      direction: DOWN`,
    `      visibilityPercentage: 100`,
    `- tapOn:`,
    `    id: "onboarding-connect"`,
    `    retryTapIfNoChange: true`,
    `- waitForAnimationToEnd:`,
    `    timeout: 3000`,
  ]
    .map((line) => `            ${line}`)
    .join("\n");
  return `${openPastePathCommands()}# Focus the pairing TextInput by testID — not the lede text that also
# contains "Paste the one-line ticket" (empty Connect is a silent no-op).
- tapOn:
    id: "pairing-code-input"
# e2e-lint-allow: unasserted-input — throwaway input only provokes iOS keyboard
# onboarding and is erased before the pairing ticket is entered.
- inputText: "x"
${dismissKeyboardOnboarding}- eraseText: 50
# e2e-lint-allow: unasserted-input — Maestro cannot reliably match long
# multiline React Native TextInput values; successful redemption below is the
# end-to-end observation of the one-time ticket. MAESTRO_* shell variables are
# resolved by Maestro without persisting the live capability in this YAML.
- inputText: \${MAESTRO_PAIRING_TICKET}
# hideKeyboard blurs the field so onBlur copies native text into codeRef
# (Android SET_TEXT can skip per-keystroke onChangeText).
- hideKeyboard
- waitForAnimationToEnd:
    timeout: 2000
# The pasted ticket can grow the field enough to push Connect off screen.
# scrollUntilVisible alone is enough when already visible (no swipe). Never
# set the center flag — that swiped a bottom-visible Connect off-screen
# (Android 30736533921). Never gate a post-tap "notVisible → scroll" fallback:
# a successful Connect tap removes the button and that branch then fails
# looking for it (Android 30738128995).
- scrollUntilVisible:
    element:
      id: "onboarding-connect"
    direction: DOWN
    visibilityPercentage: 100
- tapOn:
    id: "onboarding-connect"
    retryTapIfNoChange: true
# Give React a frame to paint Connecting… / errors before recovery. Without
# this, remount ran while still on Connect and tapped "Scan the QR code instead"
# into a hierarchy that had already left the paste form (Android 30739830232).
- waitForAnimationToEnd:
    timeout: 3000
# If still idle on the paste form, remount the field (scan instead → paste) —
# never eraseText:2000 (Android 30716166878: DEADLINE_EXCEEDED). Gate on
# onboarding-scan-instead so a successful pair that already left paste (profile
# / Connecting) cannot run recovery (Android 30742508620).
- runFlow:
    when:
      visible:
        id: "onboarding-scan-instead"
    commands:
      - runFlow:
          when:
            notVisible: "${progressOrError}"
          commands:
${remountBody}
# Iroh redemption can take >90s on cold CI. Profile h1 is one Android node
# ("Who's using this phone?") — use Who.?s using.* so full-string regex hits.
# Pairing errors surface here too so a bad ticket fails fast.
- extendedWaitUntil:
    visible: "Who.?s using.*|Enter Centraid|${homeReadyMarker}|not a Centraid pairing|expired|Could not reach|Paste a pairing ticket first.?"
    timeout: 180000
`;
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
      visible: "Who.?s using.*"
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
      - tapOn:
          id: "replica-compatibility-retry"
          retryTapIfNoChange: true
      - waitForAnimationToEnd:
          timeout: 5000
- extendedWaitUntil:
    visible: "${homeReadyMarker}"
    timeout: 120000
`;
}
