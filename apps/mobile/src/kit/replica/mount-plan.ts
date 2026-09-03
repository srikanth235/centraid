export interface PersistedMountIdentity {
  gatewayId: string;
  vaultId: string;
}

export interface MountPlanInput {
  link?: { gatewayId?: string; vaultId?: string };
  cachedBase: string;
  lastIdentity?: PersistedMountIdentity;
}

export type MountPlan =
  | ({ kind: "open"; baseUrl: string } & PersistedMountIdentity)
  | { kind: "probe" };

function complete(
  identity: { gatewayId?: string; vaultId?: string } | undefined
): PersistedMountIdentity | undefined {
  return identity?.gatewayId && identity.vaultId
    ? { gatewayId: identity.gatewayId, vaultId: identity.vaultId }
    : undefined;
}

export function planMount(input: MountPlanInput): MountPlan {
  const identity = complete(input.link) ?? complete(input.lastIdentity);
  if (!identity) return { kind: "probe" };
  return { kind: "open", baseUrl: input.cachedBase, ...identity };
}
