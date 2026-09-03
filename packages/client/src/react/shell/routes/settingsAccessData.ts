import type {
  AccessReader,
  AccessRegistryReader,
} from "../../../access-lens.js";

export * from "../../../access-lens.js";

export async function accessRegistryReader(): Promise<AccessRegistryReader> {
  const { grantBridge } = await import("../../blueprints/grant-seat.js");
  return grantBridge(() => window.CentraidApi.getGatewayAuth());
}

export async function accessReader(): Promise<AccessReader> {
  const { getReplicaShellSession } =
    await import("../../../replica/shell-session.js");
  return getReplicaShellSession();
}
