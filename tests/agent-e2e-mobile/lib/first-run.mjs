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
- tapOn: "Skip for now"
`;
}

/** Stable first-paint marker on the springboard Home (issue #498). */
export const HOME_RAIL_LABEL = 'YOUR APPS';
