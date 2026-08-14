// The capability wall (C1, docs/platform-gating.md).
//
// A gated route can still be ARRIVED at after the launcher stops offering it:
// a bookmark, a stale history entry, a notification written by an earlier
// build, the `window.Centraid.openAutomations` shim an app calls. The rule for
// that case is explicit — a capability wall, never a silent no-op — because
// the alternatives both lie. Rendering the route paints a screen whose every
// read 404s against a gateway that never mounted it; bouncing to Home tells
// the reader their click did nothing.
//
// So it says which feature, that it is off on THIS gateway, and that nothing
// was lost. It offers no button: enabling the experiment is a gateway-side
// opt-in (`CENTRAID_EXPERIMENTAL` / `gateway.experimental.*`), and a control
// here would either refuse or reach past the client's authority.
import type { JSX } from "react";

import EmptyBlock from "../ui/EmptyBlock.js";
import { CAPABILITY_LABEL } from "./capabilities.js";
import type { ExperimentalCapability } from "./capabilities.js";
import PageScroll from "./PageScroll.js";

/** What the gate is, in the reader's words. Both sentences state the same two
 *  facts — off here, data intact — because the fear a missing feature raises
 *  is "where did my things go", not "which flag is unset". */
const WALL_BODY: Readonly<Record<ExperimentalCapability, string>> = {
  automations:
    "This gateway is running with automations switched off, so there is nothing here to show. Whoever runs it can turn the experiment on; any automations an earlier build saved are still in the vault, untouched.",
  connectors:
    "This gateway is running with connectors switched off, so it holds no provider accounts and can authorize none. Whoever runs it can turn the experiment on; connections an earlier build saved are still in the vault, untouched.",
};

export default function CapabilityWall({
  capability,
}: {
  capability: ExperimentalCapability;
}): JSX.Element {
  return (
    <PageScroll>
      <EmptyBlock
        title={`${CAPABILITY_LABEL[capability]} aren’t enabled on this gateway`}
        body={WALL_BODY[capability]}
      />
    </PageScroll>
  );
}
