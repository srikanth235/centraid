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
 * true}` wipes that AsyncStorage flag, so a fresh Android launch always lands on
 * the "Welcome to Centraid" flow, not Home. iOS persists the flag across its
 * simulator, so it goes straight to Home — which is why only Android surfaced
 * this (#535). Its header "Skip" button (`Onboarding.tsx`, shown on every step
 * before `done`) calls `setOnboarded(true)` and drops straight to Home.
 *
 * Returns the YAML to WAIT for that button and tap it — the wait matters: a
 * point-in-time `runFlow: when visible` fires the instant `launchApp` returns,
 * before the JS bundle has painted onboarding, so it saw nothing and no-op'd
 * (the app then sat on onboarding until the Home assertion timed out — CI run
 * 30093591058). `timeoutMs` is the caller's first-launch budget (bundle fetch +
 * render). Empty string on non-Android platforms, so iOS's Home assertion — the
 * next step after this in every caller — is unchanged.
 */
export function skipOnboarding(platform, timeoutMs) {
  if (platform !== 'android') return '';
  return `- extendedWaitUntil:
    visible: "Skip"
    timeout: ${timeoutMs}
- tapOn: "Skip"
`;
}
