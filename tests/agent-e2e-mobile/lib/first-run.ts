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
 * Answer Android's runtime media-grant dialog with a REFUSAL.
 *
 * `launchApp: { permissions: { all: deny } }` does not cover it. Android 14
 * asks separately for visual media ("Select photos and videos" / "Allow all" /
 * "Don't allow"), and that dialog belongs to `permissioncontroller`, not to the
 * app — so a pre-denied install still gets prompted the moment Photos asks.
 *
 * Left unanswered it simply covers the app. Run 33469364358's screen digest
 * caught exactly that: while `photos-permissions` spent its whole budget
 * waiting for `photos-collections`, the screen was carrying `grant_dialog`,
 * `permission_allow_all_button` and `permission_deny_button`. The journey named
 * `permission-refused` had never once refused a permission; it timed out behind
 * an unanswered system dialog and reported the app broken.
 *
 * TEXT, NOT `id:`. The stable handle here is `permission_deny_button`, but
 * `scripts/lint-mobile-testids.mjs` requires every Maestro `id:` to resolve to a
 * `TEST_IDS` entry in `apps/mobile/src`, and an OS id is not this app's
 * vocabulary to declare — adding it there to satisfy a selector would be a lie
 * about what the app publishes. `CONFIRM_SYSTEM_OPEN` matches iOS's system
 * dialog on copy for the same reason.
 *
 * `Don.t` because the button uses a curly apostrophe (U+2019) and `.` matches
 * either form — the convention the tally flows already use for the middle dot,
 * since Maestro reads a text selector as a regex over the whole node text.
 *
 * THIS CANNOT TURN A MISSING REFUSAL INTO A PASS. The optional tap waits for a
 * dialog that may not exist and the conditional re-tap absorbs a slow mount; if
 * the dialog ever stops appearing both no-op, and the journey's own
 * `photos-access-panel` and "Photos cannot reach your camera roll" assertions
 * then fail loudly on a grant that was never refused.
 */
export const DENY_MEDIA_PERMISSION = `# Android's runtime media grant — see DENY_MEDIA_PERMISSION.
- tapOn:
    text: "Don.t allow"
    optional: true
- runFlow:
    when:
      visible: "Don.t allow"
    commands:
      - tapOn: "Don.t allow"
`;

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
