// Reusable Maestro snippets for dismissing first-run interstitials that stand
// between a fresh launch and the screen a flow actually wants to assert on.
// Split out of harness.mjs, which sits against the 500-line repo cap; these are
// plain YAML-string constants with no edge back to the harness (same reason
// metro.mjs was extracted). Interpolated into a flow's `ctx.run(...)` YAML.

import { DEV_LAUNCHER_LINK, MOBILE_E2E_EMBEDDED } from "./metro.mjs";

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
 * {@link retryableTapCommands} for taps that PUSH a screen.
 *
 * The plain variant races navigation: its conditional retry evaluates
 * `visible` immediately after the tap returns, and during the push
 * transition the source control is still in the tree — so the retry fires,
 * the transition completes under it, and the inner tap fails "Element not
 * found" against the screen it just navigated away from (places-seat's
 * "Open map", local run 06-17-23). Letting the animation settle before the
 * condition evaluates is what makes the condition honest: a completed
 * navigation renders the source control gone, a swallowed tap leaves it
 * exactly where it was.
 */
export function settledRetryableTapCommands(
  selector,
  sourceSelector = selector
) {
  const conditionalRetry = `- waitForAnimationToEnd:
    timeout: 5000
- runFlow:
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
 * Day-one recovery for a Home that has no launcher grid to tap.
 *
 * A fresh pairing against a gateway whose corpus the phone has not pulled (or
 * whose vault is genuinely empty) settles Home on the first-run hero —
 * `springboardState` (apps/mobile/src/screens/home/springboard-policy.ts)
 * renders DayOne whenever every tile settles empty, and the graded grid means
 * there is then no "Open Photos.*" tile for any tile-driven flow to tap.
 * "Fill it with sample content" (HOME_DAY_ONE_SEED_LABEL,
 * packages/client/src/home-copy.ts) is the product's own path out: it seeds
 * every seedable app through the gateway and refreshes the local replica
 * before the tiles re-read it. The button is optional, so a Home that already
 * shows the grid is untouched.
 * The fill button is optional because the paired profile may already contain
 * demo rows. Tap it as soon as Home is ready: the footer's "0 things" label is
 * not a reliable Maestro selector on iOS, while the button is the product's
 * own idempotent seed boundary. The populated Photos tile remains mandatory.
 */
export function fillSampleContentFlow(requiredLauncher = "Open Photos.*") {
  return `- tapOn:
    text: "Fill it with sample content"
    optional: true
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible: "${requiredLauncher}"
    timeout: 240000
`;
}

export const FILL_SAMPLE_IF_DAYONE = fillSampleContentFlow();

/**
 * The dev-client launcher, recovered by deep link.
 *
 * A plain `launchApp` does not always auto-load the last project: when the
 * client's Metro handshake loses the race with the launch, the app sits on
 * the launcher's "Searching for development servers…" screen (dispatch
 * 32843982898 — cold-start, volume-proof, photos-permissions, and every
 * reuse relaunch hit it). "Enter URL manually" is copy only that screen
 * publishes, and DEV_LAUNCHER_LINK is exactly what its own deep link would
 * hand it, so the recovery is conditional on the launcher and a no-op
 * everywhere else. The system-open confirmation is part of the deal (see
 * CONFIRM_SYSTEM_OPEN in harness.mjs). Run this BEFORE a flow's own
 * destination waits — a launcher-stuck launch must spend its budget here,
 * not burning the destination wait first. The inner budget is 240s because
 * the CI runner's cold bundle load is minutes, not seconds.
 */
export const LAUNCHER_RECOVERY = MOBILE_E2E_EMBEDDED
  ? ""
  : `- runFlow:
    when:
      visible: "Enter URL manually"
    commands:
      - openLink: "${DEV_LAUNCHER_LINK}"
      - tapOn:
          text: "^Open$"
          optional: true
          waitUntilVisible: true
      - extendedWaitUntil:
          visible: "All apps and places|Connect your gateway."
          timeout: 240000
`;

/**
 * The "Who's using this phone?" profile form, with a bounded recovery for the
 * lost-keystroke flake: iOS can acknowledge the field tap before the RN
 * TextInput is ready, the keystrokes land nowhere, and Continue raises the
 * product's own validation error ("Enter a name so the people you share with
 * know who you are.").
 *
 * The wait between the two is deliberate: it polls for EITHER exit — the done
 * heading or the validation error — because the error can render a beat after
 * Maestro's conditional would have evaluated (local run 08-06-14: the
 * recovery's `when` polled for seven seconds, skipped, and the error rendered
 * after it gave up). Only a CONFIRMED error triggers the re-type; the success
 * path skips it and falls through to the done heading.
 */
export const COMPLETE_PROFILE_NAME = `- runFlow:
    when:
      visible: "Who's using this phone[?]"
    commands:
      - tapOn: "Your name"
# e2e-lint-allow: unasserted-input — React Native TextInput values are not
# reliably Maestro-matchable; the personalized done heading below proves the
# submitted profile name end to end.
      - inputText: "Nightly"
      - hideKeyboard
      - tapOn: "Continue"
      - extendedWaitUntil:
          visible: "You're all set, [^.]+[.]|Enter a name so the people.*"
          timeout: 60000
      - runFlow:
          when:
            visible: "Enter a name so the people.*"
          commands:
            - tapOn: "Your name"
# e2e-lint-allow: unasserted-input — same reason; the done heading below is
# still the end-to-end observation.
            - inputText: "Nightly"
            - hideKeyboard
            - tapOn: "Continue"
`;
