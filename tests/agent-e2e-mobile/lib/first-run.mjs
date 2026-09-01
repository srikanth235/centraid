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
 * iOS may present the Photos full-access sheet immediately after pairing,
 * before Home can become visible. Only flows that claim a fully authorized
 * seeded profile opt into this boundary; the Photos-denial journey does not.
 */
export const ALLOW_PHOTOS_FULL_ACCESS = `- runFlow:
    when:
      visible: "^Allow Full Access$"
    commands:
      - tapOn: "^Allow Full Access$"
`;

/**
 * Exercise Home's own sample-data path when a paired replica is empty.
 *
 * The button is optional because a reused profile may already have content;
 * the populated Photos tile remains mandatory, so this cannot turn a missing
 * fixture or a broken replica refresh into a pass.
 */
export const FILL_SAMPLE_IF_DAYONE = `- extendedWaitUntil:
    visible: "Fill it with sample content|Open Photos.*"
    timeout: 120000
- runFlow:
    when:
      visible: "^Fill it with sample content$"
    commands:
      - tapOn:
          text: "^Fill it with sample content$"
          retryTapIfNoChange: true
- extendedWaitUntil:
    visible: "Open Photos.*"
    timeout: 240000
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
 * Open an app from Home by its stable tile handle.
 *
 * Home is a real scroll surface: the launcher order is deliberately allowed
 * to put later apps below the first viewport. Copy remains an assertion beside
 * the handle, but it is not a navigation locator because the live count is
 * part of that accessible name and changes with the vault.
 */
export function openHomeAppCommands(appId, label) {
  const tile = `home-tile-${appId}`;
  return `- scrollUntilVisible:
    element:
      id: "${tile}"
    direction: DOWN
    visibilityPercentage: 100
    timeout: 30000
- assertVisible:
    id: "${tile}"
- assertVisible: "${label}"
- tapOn:
    id: "${tile}"
    retryTapIfNoChange: true`;
}

/**
 * Enter an app-level journey through the product's registered URL path.
 * App journeys must not make the Home springboard a prerequisite: that turns
 * a shell-navigation regression into a dozen unrelated app failures. The
 * shell has its own roster in native-v0-resilience; this helper starts at the
 * app's actual cover and keeps the assertions below about that app's replica
 * and writes.
 */
export function openAppLinkCommands(path) {
  return `- openLink: "centraid://${path}"`;
}
