// Establish the fully seeded replica used by the iOS app-level roster.
//
// `photos-permissions` intentionally pairs an empty Photos gateway first so it
// can prove the iOS refusal takeover. The bootstrap below uses Home's own
// sample-content action, which seeds the gateway and rebuilds the phone's
// replica because demo writes intentionally sit outside the change feed. The
// canary and the permission journey remain separate claims.

import { ALLOW_PHOTOS_FULL_ACCESS } from "../lib/first-run.mjs";
import { HOME_READY_MARKER, runFlow } from "../lib/harness.mjs";

await runFlow("ios-roster-bootstrap", async (ctx) => {
  await ctx.configureGateway({
    fresh: true,
    permissionCommands: ALLOW_PHOTOS_FULL_ACCESS,
    fillSampleContent: true,
  });
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: 45000
- takeScreenshot: ios-roster-seeded-home
`,
    "seeded-home"
  );

  return {
    pass: true,
    notes:
      "Home's sample-content action seeded the deterministic app corpus and the fresh replica exposed it to the iOS app roster",
  };
});
