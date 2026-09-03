export const DISMISS_KEYBOARD_ONBOARDING = `- runFlow:
    when:
      visible: "^Continue$"
    commands:
      - tapOn: "^Continue$"
`;

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
