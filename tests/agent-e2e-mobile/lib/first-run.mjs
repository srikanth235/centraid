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
      visible: "Continue"
    commands:
      - tapOn: "Continue"
`;

/**
 * First-run onboarding (`src/screens/Onboarding.tsx`) renders ahead of the tab
 * shell whenever `profile.onboarded` is false — and `launchApp: {clearState:
 * true}` wipes that AsyncStorage flag, so a fresh launch lands on the "Welcome
 * to Centraid" flow, not Home. Its header "Skip onboarding" button calls
 * `setOnboarded(true)` and drops straight to Home, so tap it before asserting on
 * any Home copy. Conditional (`when: visible`) so it is a no-op when a launch
 * keeps state, or on a device that is already past onboarding — e.g. iOS, whose
 * simulator persists the flag across runs where Android's clearState clears it,
 * which is why the Android lane was the first to surface this (#535). Keyed on
 * the button's accessibilityLabel, matched the same way as the per-screen
 * markers the other flows use.
 */
export const SKIP_ONBOARDING = `- runFlow:
    when:
      visible: "Skip onboarding"
    commands:
      - tapOn: "Skip onboarding"
`;
