// Capability wall (C1, docs/platform-gating.md): a directly-arrived gated
// route gets a wall — NEVER a silent no-op or an enable control.
import type { JSX } from "react";

import EmptyBlock from "../ui/EmptyBlock.js";
import { CAPABILITY_LABEL } from "./capabilities.js";
import type { ExperimentalCapability } from "./capabilities.js";
import PageScroll from "./PageScroll.js";

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
