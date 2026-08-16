// The gateway's experimental feature gates, as the shell sees them (C1,
// docs/platform-gating.md).
//
// Automations and connectors ship in the binary but default OFF for v0: an
// enthusiast opts in per gateway, and a gateway that predates the flag simply
// omits it. When a feature is off the gateway does not mount its routes
// (`/centraid/_automations`, `/centraid/_insights`, the vault connections +
// OAuth callback family), so a client that still shows its destinations is
// offering places that answer 404.
//
// Detection therefore happens in ONE place — `useGatewayCapabilities` reads
// the info handshake once at shell boot and publishes the verdict — and every
// surface reads THAT rather than re-deriving its own. This module is the pure
// half: the shape, the safe defaults, and the single route→capability table.
// It holds no React so the launcher model (which is data, not a component) can
// import the type without importing a renderer.

import type { GatewayCapabilities } from "@centraid/core/protocol";

/** The two gates a surface can require. Absent from a destination or a route
 *  means it is always available. */
export type ExperimentalCapability = "automations" | "connectors";

export type ShellCapabilities = Readonly<
  Record<ExperimentalCapability, boolean>
>;

/**
 * What the shell believes before the handshake answers, and what an unreachable
 * or malformed handshake leaves it believing.
 *
 * OFF is the honest default in both directions: v0 ships both features off, so
 * hiding until told otherwise shows the majority the truth immediately, while
 * flashing the destinations and then withdrawing them would advertise places
 * most gateways do not have. The cost is a short pop-in for the enthusiast who
 * opted in, which is the cheaper of the two wrong first frames.
 */
export const CAPABILITIES_OFF: ShellCapabilities = Object.freeze({
  automations: false,
  connectors: false,
});

/** Everything on — the value a surface renders under when nothing has gated it
 *  (an unmounted test tree, a host with no handshake of its own). Never the
 *  default the shell root publishes; see `CAPABILITIES_OFF`. */
export const CAPABILITIES_ON: ShellCapabilities = Object.freeze({
  automations: true,
  connectors: true,
});

/** Project the wire map onto the two gates. Absent reads as off — the optional
 *  keys are how an older gateway handshakes clean (protocol/capabilities.ts). */
export function shellCapabilitiesFrom(
  map: GatewayCapabilities | undefined
): ShellCapabilities {
  return {
    automations: map?.automations === true,
    connectors: map?.connectors === true,
  };
}

/**
 * The one route→capability table.
 *
 * Keyed by `ShellRoute["kind"]`, but typed on a bare string so the caller can
 * hand over a route kind it has not narrowed (a stale history entry, a deep
 * link, the `window.Centraid` shim) without a cast. A kind that is not here
 * needs no capability.
 *
 * ANALYTICS IS AN AUTOMATIONS SURFACE. It reads the run rollup over
 * `/centraid/_insights` and resolves display names from `/centraid/_automations`
 * — both unmounted with the gate off — so it is listed here rather than left
 * to fail as an empty page that never explains itself.
 */
const ROUTE_CAPABILITY: Readonly<Record<string, ExperimentalCapability>> =
  Object.freeze({
    "automation-builder": "automations",
    "automation-editor": "automations",
    "automation-view": "automations",
    automations: "automations",
    connectors: "connectors",
    insights: "automations",
    "run-view": "automations",
    templates: "automations",
  });

/** Which gate a route kind sits behind, if any. */
export function routeCapability(
  kind: string
): ExperimentalCapability | undefined {
  return ROUTE_CAPABILITY[kind];
}

/** Is this route reachable under these capabilities? */
export function isRouteAvailable(
  kind: string,
  capabilities: ShellCapabilities
): boolean {
  const needed = routeCapability(kind);
  return needed === undefined || capabilities[needed];
}

/** The feature's name in the reader's words, for the capability wall. */
export const CAPABILITY_LABEL: Readonly<
  Record<ExperimentalCapability, string>
> = Object.freeze({
  automations: "Automations",
  connectors: "Connectors",
});
