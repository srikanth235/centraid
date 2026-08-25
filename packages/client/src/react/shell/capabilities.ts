// Feature gates (C1, docs/platform-gating.md): detected ONCE at boot, and every
// surface reads that verdict. `insights` sits behind `automations` — both its
// routes unmount with that gate.

import type { GatewayCapabilities } from "@centraid/core/protocol";

export type ExperimentalCapability = "automations" | "connectors";

export type ShellCapabilities = Readonly<
  Record<ExperimentalCapability, boolean>
>;

export const CAPABILITIES_OFF: ShellCapabilities = Object.freeze({
  automations: false,
  connectors: false,
});

export const CAPABILITIES_ON: ShellCapabilities = Object.freeze({
  automations: true,
  connectors: true,
});

export function shellCapabilitiesFrom(
  map: GatewayCapabilities | undefined
): ShellCapabilities {
  return {
    automations: map?.automations === true,
    connectors: map?.connectors === true,
  };
}

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

export function routeCapability(
  kind: string
): ExperimentalCapability | undefined {
  return ROUTE_CAPABILITY[kind];
}

export function isRouteAvailable(
  kind: string,
  capabilities: ShellCapabilities
): boolean {
  const needed = routeCapability(kind);
  return needed === undefined || capabilities[needed];
}

export const CAPABILITY_LABEL: Readonly<
  Record<ExperimentalCapability, string>
> = Object.freeze({
  automations: "Automations",
  connectors: "Connectors",
});
