import {
  DENY_MEDIA_PERMISSION,
  retryableTapCommands,
} from "../lib/first-run.mjs";
import {
  CONFIRM_SYSTEM_OPEN,
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

await runFlow("photos-permissions", async (ctx) => {
  await ctx.purgeDemo("photos");
  await ctx.configureGateway();
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- launchApp:
    clearState: false
    permissions:
      all: deny
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- openLink: "centraid://photos"
${CONFIRM_SYSTEM_OPEN}${DENY_MEDIA_PERMISSION}- extendedWaitUntil:
    visible:
      id: "photos-collections"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
# The band destination by its KEY (photos-band.ts already keys on it), never
# its label — and never the conditional-retry helper, which would not stop
# retrying against a tab that stays on screen.
- tapOn:
    id: "photos-band-library"
    retryTapIfNoChange: true
# THE REFUSAL IS THE CLAIM AND STAYS COPY. photos-access-panel is only how the
# takeover is FOUND; the sentence is what the OS's refusal is turned into for a
# member, and a flow that stopped asserting it would stop proving anything.
- extendedWaitUntil:
    visible:
      id: "photos-access-panel"
    timeout: 20000
# ASK, THEN REFUSE — a pre-revoked grant is not a refused one (#905).
#
# \`permissions: { all: deny }\` on the launch above revokes through adb, and a
# permission the app has never REQUESTED is left "not requested" rather than
# denied, so \`getPermissionsAsync\` answers \`undetermined\` and
# \`photoAccessState\` correctly reports the never-asked state. The panel then
# draws "Photos has not asked for your camera roll yet", which is true, and the
# denied sentence below could never appear. Run 33556574795 is the first one
# that reached this assertion with budget to spare, and that is what it found.
#
# The panel's own primary control is the ask (photos-access-ask, "Allow
# access"), so the journey now takes the path a member takes: it asks, the OS
# puts up the real dialog, and the refusal below is the answer to a question
# that was actually put. That also settles the staleness the mount-time read
# would otherwise leave, since the panel re-renders from the request's own
# result. Nothing here is loosened — the assertion is unchanged and now has a
# refused grant behind it.
- tapOn:
    id: "photos-access-ask"
    retryTapIfNoChange: true
${DENY_MEDIA_PERMISSION}- extendedWaitUntil:
    visible: "Photos cannot reach your camera roll"
    timeout: 20000
- assertVisible: "Photos cannot reach your camera roll"
# The two recovery labels are alternates because which one a refused state earns
# is the OS's answer, not the app's — and each is a real control (photos-access-
# ask / photos-access-settings), which is why the label is asserted rather
# than a handle: naming one handle here would pin the flow to one OS answer.
- assertVisible: "Allow access|Open Settings"
- assertVisible:
    id: "photos-select"
    enabled: false
- assertVisible:
    text: "Select"
    enabled: false
- takeScreenshot: photos-permission-takeover
# The way home is the one thing an app may never take away, and the refusal
# takeover is exactly where it would be lost. Asserting the capsule's label
# proved nothing: "Home" is also the frame's tab-bar label, so the assertion
# passed on every screen in the app whether the capsule rendered or not
# (route-name). Tap it and require Home to actually arrive — that is the
# claim this journey's verdict makes ("escapable through Home"), and only a
# real return can fail when the capsule is missing or wired to a no-op.
#
# THE CAPSULE HAS NO HANDLE. kit/band/band-capsule.ts is the frame's shared
# way home and nothing in kit/test-ids.ts names it, so this tap stays on copy —
# an invented id would fail scripts/lint-mobile-testids.mjs the moment it was
# written. Reported as a gap under #890 W2. The tap is safe as copy precisely
# because the ASSERTION below is not: arriving at Home is what is proven.
${retryableTapCommands("Home", "Photos cannot reach your camera roll")}
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: 30000
`,
    "permission-refused"
  );
  return {
    pass: true,
    notes:
      "refused device permission took over an empty vault library with recovery, and the way home returned to Home",
  };
});
