import type { JSX } from "react";

import GatewayRoute from "./GatewayRoute.js";

// React-owned Storage route (issue #544 — this was BackupsRoute). Local
// footprint, the owner's limits, and the offsite snapshot custody that used
// to be the whole page. Every card fetches its own status over plain HTTP and
// renders its own loading/error state, so unlike GatewayRoute there is NO
// snapshot gate here: Storage has nothing to do with the main-process
// heartbeat monitor, and blocking on `useGatewayRuntime()` would leave the
// page blank whenever the heartbeat is merely late — for a page whose whole
// job is reassurance about durability, "we can't even tell you" is the worst
// possible first paint. The only thing the route owns is the 1s ticker
// driving the backup card's relative ages ("verified 4m ago"), same as
// GatewayRoute.
export default function StorageRoute(): JSX.Element {
  return <GatewayRoute initialTab="storage" />;
}
