import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { retryableTapCommands } from "../lib/first-run.mjs";
import {
  AWAIT_LAUNCHER,
  FIRST_LAUNCH_TIMEOUT_MS,
  HOME_READY_MARKER,
  runFlow,
} from "../lib/harness.mjs";

const BALANCES_STATUS =
  "Every figure is derived at read time . no balance is stored and none is transmitted";
const GROUPS_STATUS =
  "A group is a shared circle . members co-contribute from their own vaults";
const GROUP_HERO_SUB =
  "Every member computes this figure themselves, from the same facts.";

const SHARE_VERB = "Share group";
const SHARE_META = "each member you are linked with gets it in their own vault";
const SHARE_OFFLINE =
  "Sharing needs a gateway connection . it cannot be queued";

const SHEET_NOTE = "Everyone you add gets the full shared item.*";

const LINK_SECTION = "LINK WITH SOMEONE";
const PEOPLE_SECTION = "PEOPLE";
const LINK_FIELD = "Pasted link ticket";

const SHARING_ROW = "People you are linked with";

const DEMO_GROUP = "Tahoe Trip";

await runFlow("sharing-reach", async (ctx) => {
  await ctx.ensureDemo("tally");
  await ctx.configureGateway();

  await ctx.run(
    `appId: ${ctx.state.appId}
---
${AWAIT_LAUNCHER}${retryableTapCommands("Open Tally.*")}
- extendedWaitUntil:
    visible: "${BALANCES_STATUS}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
# The band destination by its KEY (tally-band.ts already keys on it), never
# its label: "Groups" is copy shelves.ts owns and may re-word.
- tapOn:
    id: "tally-band-groups"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible: "${GROUPS_STATUS}"
    timeout: 20000
${retryableTapCommands(DEMO_GROUP, GROUPS_STATUS)}
- extendedWaitUntil:
    visible: "${GROUP_HERO_SUB}"
    timeout: 20000
# The life-acts section sits below the group's ledger, and the ledger is as
# long as the group is old. Scrolled to by the verb's own handle: the row is
# the SUBJECT of this journey's first claim, and finding it by the words it
# prints would make a copy edit indistinguishable from the row disappearing.
- scrollUntilVisible:
    element:
      id: "tally-share-verb"
    direction: DOWN
    visibilityPercentage: 100
    timeout: 20000
# WHAT AN INVITATION IS, said before it is pressed: one each, and redeemed in
# the other person's own vault rather than granting access to this one. THIS
# stays copy — it is the promise, not the locator.
- assertVisible: "${SHARE_META}"
- assertVisible: "${SHARE_VERB}"
- tapOn:
    id: "tally-share-verb"
- extendedWaitUntil:
    visible:
      id: "shell-share-sheet"
    timeout: 20000
# …and the sheet states the consequence of joining in its own words, whoever
# this vault does or does not have to hand it to.
- assertVisible: "${SHEET_NOTE}"
- takeScreenshot: sharing-tally-group-sheet
- tapOn:
    id: "shell-share-sheet-cancel"
- extendedWaitUntil:
    visible: "${GROUP_HERO_SUB}"
    timeout: 20000
`,
    "share-a-group"
  );
  ctx.note(
    `Tally group "${DEMO_GROUP}" offered Share group with its own meta, and the share sheet opened on it`
  );

  await ctx.run(
    `appId: ${ctx.state.appId}
---
- stopApp
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- tapOn:
    id: "home-band-more"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible:
      id: "home-all-apps"
    timeout: 15000
- scrollUntilVisible:
    element:
      id: "home-place-settings"
    direction: DOWN
    visibilityPercentage: 100
    timeout: 20000
- tapOn:
    id: "home-place-settings"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible:
      id: "settings-screen"
    timeout: 20000
# "APPEARANCE" is the first section Settings publishes and nothing else in the
# app renders it — kept beside the handle because it proves the screen actually
# PAINTED, which a root testID on a mounted-but-empty view would not.
- assertVisible: "APPEARANCE"
- scrollUntilVisible:
    element:
      id: "settings-sharing-row"
    direction: DOWN
    visibilityPercentage: 100
    timeout: 20000
# The row's own sentence stays asserted — its accessible name is the bare word
# "Sharing", which the section heading above it also carries, so this sentence
# is what tells the two apart for a reader of the verdict.
- assertVisible: "${SHARING_ROW}"
- tapOn:
    id: "settings-sharing-row"
- extendedWaitUntil:
    visible:
      id: "sharing-screen"
    timeout: 20000
# The two halves of the ONE mechanism: the ceremony that makes a person
# reachable, and the roster it writes. Nothing else is on this screen.
- assertVisible: "${LINK_SECTION}"
- assertVisible: "${LINK_FIELD}"
- assertVisible: "${PEOPLE_SECTION}"
- assertVisible:
    id: "sharing-people"
- takeScreenshot: sharing-link-surface
`,
    "linking-surface"
  );
  ctx.note(
    "Settings → Sharing drew the link ceremony and the roster it writes"
  );

  const uiImpactDir = "artifacts/e2e/ui-impact";
  const screenshot = async (suffix, published) => {
    const frames = await readdir(ctx.state.screenshotsDir);
    const frame = frames.find((name) => name === `${suffix}.png`);
    if (frame === undefined)
      throw new Error(`${suffix} frame was not captured`);
    await mkdir(uiImpactDir, { recursive: true });
    await copyFile(
      path.join(ctx.state.screenshotsDir, frame),
      path.join(uiImpactDir, published)
    );
  };
  await screenshot(
    "sharing-tally-group-sheet",
    "issue-880-mobile-share-group-sheet.png"
  );
  await screenshot(
    "sharing-link-surface",
    "issue-880-mobile-sharing-screen.png"
  );

  if (ctx.state.platform === "android") {
    try {
      await ctx.run(
        `appId: ${ctx.state.appId}
---
- stopApp
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${AWAIT_LAUNCHER}${retryableTapCommands("Open Tally.*")}
- extendedWaitUntil:
    visible: "${BALANCES_STATUS}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- tapOn:
    id: "tally-band-groups"
    retryTapIfNoChange: true
- extendedWaitUntil:
    visible: "${GROUPS_STATUS}"
    timeout: 20000
${retryableTapCommands(DEMO_GROUP, GROUPS_STATUS)}
- extendedWaitUntil:
    visible: "${GROUP_HERO_SUB}"
    timeout: 20000
- scrollUntilVisible:
    element:
      id: "tally-share-verb"
    direction: DOWN
    visibilityPercentage: 100
    timeout: 20000
- assertVisible: "${SHARE_META}"
# The gateway goes out of reach UNDER a group that is already on screen: the
# ledger is a gateway read and would not land again, so this is the state a
# member is actually in when the radio drops.
- setAirplaneMode: enabled
- extendedWaitUntil:
    visible: "${SHARE_OFFLINE}"
    timeout: 30000
# THE WITHHELD VERB. The row now carries the sentence INSTEAD of what it offers
# when the gateway is reachable — not both, and not a greyed control. The row
# ITSELF is still drawn (its handle is on the LedgerRow either way), which is
# what separates "withheld with a reason" from "hidden", the distinction the
# refusal grammar in docs/blueprint-seats.md turns on.
- assertVisible:
    id: "tally-share-verb"
- assertNotVisible: "${SHARE_META}"
- takeScreenshot: sharing-withheld-offline
`,
        "withheld-while-disconnected"
      );
      ctx.note(
        "Android: with the gateway out of reach the group drew the offline sentence and withdrew the invitation meta"
      );
    } finally {
      await ctx.run(
        `appId: ${ctx.state.appId}
---
- setAirplaneMode: disabled
`,
        "restore-network"
      );
    }
  } else {
    ctx.note(
      "iOS Simulator has no Maestro airplane control; the withheld-verb half is covered on every platform by apps/mobile/src/apps/tally/TallyShareGroup.test.tsx"
    );
  }

  return {
    pass: true,
    notes:
      "the phone compiled a share from a Tally group, and the surface that makes a person reachable loaded",
  };
});
