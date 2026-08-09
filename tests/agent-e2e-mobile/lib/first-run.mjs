// Reusable Maestro snippets for first-run interstitials and onboarding recovery.
// Keep the generated YAML beside the harness so iOS/Android accessibility
// workarounds remain auditable instead of being hidden in a large flow string.

/**
 * The first keystroke on a freshly-booted simulator raises iOS's multilingual
 * keyboard onboarding sheet ("Type English and Dutch … Continue"). It covers
 * the bottom of the screen and swallows later taps, so provoke and dismiss it
 * before entering the real ticket.
 */
export const DISMISS_KEYBOARD_ONBOARDING = `- runFlow:
    when:
      visible: "^Continue$"
    commands:
      - tapOn: "^Continue$"
`;

/**
 * Cold Android emulators occasionally raise a system ANR sheet above Centraid.
 * Keep the app running by tapping Wait; never close the app underneath.
 */
export const DISMISS_SYSTEM_ANR = `- runFlow:
    when:
      visible: ".*isn't responding.*"
    commands:
      - tapOn: "Wait"
`;

/**
 * iOS asks for confirmation when Maestro opens the Expo development-client
 * URL scheme. The prompt sits above the native hierarchy, so accept it before
 * looking for either Expo's first-use sheet or Centraid's onboarding screen.
 */
export const DISMISS_OPEN_LINK_CONFIRMATION = `- runFlow:
    when:
      visible: "^Open$"
    commands:
      - tapOn: "^Open$"
`;

/**
 * Expo's development build shows this first-use sheet on a fresh simulator.
 * It is above the React Native hierarchy, so dismiss it before polling for
 * onboarding. The exact Continue label is also used by iOS keyboard setup;
 * handling it here makes both overlays safe during cold launch.
 */
export const DISMISS_FIRST_USE_CONTINUE = `- runFlow:
    when:
      visible: "^Continue$"
    commands:
      - tapOn: "^Continue$"
`;

/**
 * After the first-use sheet is accepted, Expo leaves its developer menu open.
 * Reload closes that menu and returns to the app with the Metro bundle loaded;
 * the menu's "Go home" action would return to the dev-client launcher.
 */
export const DISMISS_EXPO_DEV_MENU = `- runFlow:
    when:
      visible: "^Reload$"
    commands:
      - tapOn: "^Reload$"
`;

export const DISMISS_DEV_CLIENT_OVERLAYS =
  `${DISMISS_SYSTEM_ANR}${DISMISS_OPEN_LINK_CONFIRMATION}` +
  `${DISMISS_FIRST_USE_CONTINUE}${DISMISS_EXPO_DEV_MENU}`;

/**
 * Poll for the paired shell while dismissing overlays that can arrive after
 * an iOS dev-client deep link. A one-shot conditional is not enough here:
 * XCTest can report the URL command complete before iOS presents its Open
 * confirmation, leaving the confirmation above a healthy Home screen.
 */
export function waitForHomeReadyCommands(timeoutMs, platform = "ios") {
  const pollMs = 5_000;
  const times = Math.max(1, Math.ceil(timeoutMs / pollMs));
  const recentServerTapInside =
    platform === "ios"
      ? `${indentMaestroCommands(IOS_METRO_RECENT_SERVER_TAP.trim(), 6)}\n`
      : "";
  const dismissInside = DISMISS_DEV_CLIENT_OVERLAYS.split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `      ${line}`)
    .join("\n");
  return `${DISMISS_DEV_CLIENT_OVERLAYS}${
    platform === "ios" ? IOS_METRO_RECENT_SERVER_TAP : ""
  }- repeat:
    times: ${times}
    while:
      notVisible:
        text: "Home ready"
    commands:
${recentServerTapInside}${dismissInside}
      - waitForAnimationToEnd:
          timeout: ${pollMs}
${DISMISS_DEV_CLIENT_OVERLAYS}${
    platform === "ios" ? IOS_METRO_RECENT_SERVER_TAP : ""
  }- extendedWaitUntil:
    visible:
      text: "Home ready"
    timeout: ${pollMs}
`;
}

/** Indent a generated Maestro command block for use inside `repeat`. */
export function indentMaestroCommands(commands, spaces) {
  const prefix = " ".repeat(spaces);
  return commands
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

// `launchApp: { clearState: true }` also clears the Expo development client's
// cached Metro URL on iOS. Re-inject the URL through the app's development
// client route before waiting for the React Native onboarding hierarchy; without
// this, the simulator remains on the development-client launcher indefinitely.
const IOS_METRO_DEV_CLIENT_LINK =
  "dev.centraid.mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081";
// Expo's launcher keeps the last Metro server as a tappable card. On iOS 26
// `simctl openurl` can time out while the just-launched dev client restores
// that card; tapping the visible card is the equivalent recovery path (#676).
const IOS_METRO_RECENT_SERVER = ".*127.0.0.1:8081.*";
const IOS_METRO_RECENT_SERVER_TAP = `- runFlow:
    when:
      visible: "${IOS_METRO_RECENT_SERVER}"
    commands:
      - tapOn:
          text: "${IOS_METRO_RECENT_SERVER}"
          retryTapIfNoChange: true
`;

/**
 * Reconnect a cleared iOS Expo development client to the already-running Metro
 * server. Android's dev client does not use this iOS URL route.
 */
export function relaunchDevClientCommands(platform) {
  if (platform !== "ios") return "";
  // `simctl openurl` can return after the dev client hands control back to
  // SpringBoard; launch again so the cached Metro card is reachable.
  return `- openLink:
    link: "${IOS_METRO_DEV_CLIENT_LINK}"
    optional: true
- waitForAnimationToEnd:
    timeout: 3000
- launchApp:
    clearState: false
- waitForAnimationToEnd:
    timeout: 1000
${IOS_METRO_RECENT_SERVER_TAP}
- waitForAnimationToEnd:
    timeout: 1000
`;
}

/**
 * Poll for onboarding while dismissing native/Expo overlays between polls.
 * This keeps transient OS dialogs from consuming the whole launch budget.
 */
export function waitForOnboardingConnectCommands(timeoutMs, platform = "ios") {
  const pollMs = 5_000;
  const times = Math.max(1, Math.ceil(timeoutMs / pollMs));
  const recentServerTapInside =
    platform === "ios"
      ? `${indentMaestroCommands(IOS_METRO_RECENT_SERVER_TAP.trim(), 6)}\n`
      : "";
  const dismissInside = DISMISS_DEV_CLIENT_OVERLAYS.split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `      ${line}`)
    .join("\n");
  return `${DISMISS_DEV_CLIENT_OVERLAYS}${
    platform === "ios" ? IOS_METRO_RECENT_SERVER_TAP : ""
  }- repeat:
    times: ${times}
    while:
      notVisible:
        text: "Connect your gateway."
    commands:
${recentServerTapInside}${dismissInside}
      - waitForAnimationToEnd:
          timeout: ${pollMs}
${DISMISS_SYSTEM_ANR}${
    platform === "ios" ? IOS_METRO_RECENT_SERVER_TAP : ""
  }- extendedWaitUntil:
    visible:
      text: "Connect your gateway."
    timeout: ${pollMs}
`;
}

/**
 * Tap an animated React Native control without treating its press animation as
 * proof that navigation happened. Callers must still assert the destination.
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
 * Open a bundled native cover through the visible All-apps sheet.
 *
 * This is intentionally a UI route rather than a `centraid://` shortcut: an
 * iOS simulator can accept the system URL confirmation and still deliver the
 * app back to Home after a development-client relaunch. Searching first also
 * avoids relying on the sheet's scroll position as the catalog grows.
 */
export function openAppFromAllAppsCommands(appName) {
  return [
    // The bottom-band button and the sheet title share an accessibility label.
    // A generic retry helper would tap the non-interactive title after the
    // sheet opens, so keep the retry on the first, visible button only.
    `- tapOn:
    text: "All apps and places"
    retryTapIfNoChange: true`,
    `- extendedWaitUntil:
    visible:
      text: "Search all apps and places"
    timeout: 15000`,
    `- tapOn:
    text: "Search all apps and places"
    retryTapIfNoChange: true`,
    `- inputText: "${appName}"`,
    // Maestro's iOS hideKeyboard taps the transparent Modal scrim here and
    // closes the sheet. Submit the search field instead: its return key blurs
    // the native input while preserving the Modal, so the filtered row is
    // actually tappable when the keyboard covers the lower part of the sheet.
    `- pressKey: Enter`,
    `- waitForAnimationToEnd:
    timeout: 1000`,
    `- extendedWaitUntil:
    visible:
      text: "Open ${appName}.*"
    timeout: 15000`,
    `- tapOn:
    text: "Open ${appName}.*"
    retryTapIfNoChange: true`,
  ].join("\n");
}

/**
 * Open the scan-first paste path by testID and wait for the native field.
 * Text/lede matches can complete without flipping the React state on iOS.
 */
export function openPastePathCommands() {
  return `# Text taps can complete while the hierarchy settles without opening paste.
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
- extendedWaitUntil:
    visible:
      id: "pairing-code-input"
    timeout: 15000
`;
}

/**
 * Enter the live pairing ticket, submit it, and recover once if the native
 * field accepted the text without React receiving the update. The final wait
 * is intentionally broad: it accepts either profile, Done, Home, or a real
 * pairing error so a bad path fails at the point of cause.
 */
export function pasteAndConnectPairingTicketCommands(
  homeReadyMarker,
  dismissKeyboardOnboarding = DISMISS_KEYBOARD_ONBOARDING
) {
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

  return `${openPastePathCommands()}# Focus the pairing TextInput by testID.
- tapOn:
    id: "pairing-code-input"
# e2e-lint-allow: unasserted-input — throwaway input only provokes iOS keyboard
# onboarding and is erased before the pairing ticket is entered.
- inputText: "x"
${dismissKeyboardOnboarding}- eraseText: 50
# e2e-lint-allow: unasserted-input — successful redemption below is the check.
- inputText: \${MAESTRO_PAIRING_TICKET}
- hideKeyboard
- waitForAnimationToEnd:
    timeout: 2000
# A long ticket can push Connect below the viewport; scroll it fully into view.
- scrollUntilVisible:
    element:
      id: "onboarding-connect"
    direction: DOWN
    visibilityPercentage: 100
- tapOn:
    id: "onboarding-connect"
    retryTapIfNoChange: true
- waitForAnimationToEnd:
    timeout: 3000
# If the native field is still idle, remount the paste field and re-drive it.
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
- extendedWaitUntil:
    visible: "Who.?s using.*|Enter Centraid|${homeReadyMarker}|not a Centraid pairing|expired|Could not reach|Paste a pairing ticket first.?"
    timeout: 180000
`;
}

/**
 * Complete the new-owner profile with the native field contract. The stable
 * test ID avoids a 25-second iOS hierarchy search against the placeholder, and
 * the bounded second pass handles the same native-event wedge as pairing if
 * Continue observes an empty React-side value.
 */
export function completeProfileCommands() {
  return `- tapOn:
    id: "onboarding-profile-name"
    retryTapIfNoChange: true
# e2e-lint-allow: unasserted-input — the personalized Done heading proves the
# profile submission end to end.
- inputText: "Nightly"
- hideKeyboard
- tapOn:
    text: "^Continue$"
    retryTapIfNoChange: true
- waitForAnimationToEnd:
    timeout: 1000
- runFlow:
    when:
      visible: "Enter a name so the people you share with know who you are[.]"
    commands:
      - tapOn:
          id: "onboarding-profile-name"
          retryTapIfNoChange: true
      - eraseText: 60
# e2e-lint-allow: unasserted-input — the retry is only entered after the
# required-name error proves the first native event was lost.
      - inputText: "Nightly"
      - hideKeyboard
      - tapOn:
          text: "^Continue$"
          retryTapIfNoChange: true
`;
}

/**
 * Finish the profile/Done steps, then give the shell capability probe time to
 * reach Home. Retry is sparse because the in-product probe itself takes about
 * 18 seconds; remounting on every wall flicker starves that probe forever.
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
${indentMaestroCommands(completeProfileCommands(), 6)}
- runFlow:
    when:
      visible: "Enter Centraid"
    commands:
${enterCentraid}
- extendedWaitUntil:
    visible: "${homeReadyMarker}"
    timeout: 25000
    optional: true
- repeat:
    times: 8
    while:
      notVisible: "${homeReadyMarker}"
    commands:
      - runFlow:
          when:
            visible: "Reconnect once"
          commands:
            - tapOn:
                id: "replica-compatibility-retry"
                retryTapIfNoChange: true
            - extendedWaitUntil:
                visible: "${homeReadyMarker}"
                timeout: 25000
                optional: true
- extendedWaitUntil:
    visible: "${homeReadyMarker}"
    timeout: 60000
`;
}
