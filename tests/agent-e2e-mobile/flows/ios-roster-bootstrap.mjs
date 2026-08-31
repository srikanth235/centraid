// Establish the fully seeded replica used by the iOS app-level roster.
//
// `photos-permissions` intentionally pairs an empty Photos gateway first so it
// can prove the iOS refusal takeover. Seeding after that pairing only changes
// gateway state; it does not rewrite the phone's initial replica clone. This
// boundary seeds every deterministic app scenario, then pairs a fresh client so
// all later app journeys observe the same complete corpus while reusing one
// profile. The canary and the permission journey remain separate claims.

import { HOME_READY_MARKER, runFlow } from "../lib/harness.mjs";

const SEEDED_APPS = [
  "docs",
  "agenda",
  "notes",
  "tasks",
  "people",
  "tally",
  "photos",
];

await runFlow("ios-roster-bootstrap", async (ctx) => {
  for (const appId of SEEDED_APPS) {
    // The gateway seed endpoint is idempotent; keeping the list explicit makes
    // the fixture contract visible to reviewers and future roster edits.
    await ctx.ensureDemo(appId);
  }

  await ctx.configureGateway({ fresh: true });
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
      `fresh replica contains ${SEEDED_APPS.length} deterministic app scenarios for the iOS app roster`,
  };
});
