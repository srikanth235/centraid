// WHAT THIS PHONE CAN OPEN WITHOUT ASKING ANYONE. Phase A is pure and decides
// from DISK ALONE: `MountPlan` has two shapes, neither of them "ask the network
// first". "Unpaired" is a DISK FACT, never a network verdict.
export interface PersistedMountIdentity {
  gatewayId: string;
  vaultId: string;
}

export interface MountPlanInput {
  /** `vaultId` is `''` while a gateway resolves — that case must probe. */
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
