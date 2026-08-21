// WHAT THIS PHONE CAN OPEN WITHOUT ASKING ANYONE.
//
// THE ONE THIS MODULE EXISTS FOR: a cold start with no reachable gateway used
// to render skeletons forever and never open the replica databases at all.
// Observed on a real device by launching with the desktop asleep — the replica
// files' mtimes were untouched across the whole launch while the SQLite file on
// disk held 528 rows the member had already synced. The vault was there. The
// app just would not look at it.
//
// The cause was an ordering, not a missing feature. `ReplicaProvider` mounted in
// the order `resolveIdentity → compatibility wall → scopes → open databases`,
// and `resolveIdentity` opened with `await resolveGatewayBase()`, which reaches
// `ensureTunnelStarted()` → `startTunnel()`. That start had no budget, so on a
// launch where the peer never answers it simply never settles. `ready` never
// flipped, `connection` stayed `loading`, and LOCAL DATA WAS WITHHELD BECAUSE
// THE NETWORK DID NOT ANSWER. For a local-first product that is the defect: the
// bytes are on the device, and nothing about reading them needs a gateway's
// participation.
//
// So the mount is two phases, and this module is the whole of phase A:
//
//   Phase A (here, and pure)  — decide from DISK ALONE what to open. Never
//     awaits, never fetches, and has no state in which the answer is "wait".
//   Phase B (ReplicaProvider) — the existing `refreshReachability` pass. It
//     resolves the live base, patches it into the multiplex and the session
//     facade, pulls, and settles reachability. Everything network-shaped lives
//     there, where it is allowed to fail slowly.
//
// The rule that makes the regression unrepresentable: **`MountPlan` has exactly
// two shapes, and neither of them is "ask the network first".** A device with a
// persisted identity gets `open` — immediately, offline, from the cached base.
// Only a device with nothing on disk gets `probe`, because that is the one case
// where the network genuinely holds the only copy of the answer.
//
// That second rule has a corollary worth stating on its own: "unpaired" is a
// DISK FACT. It used to be a network verdict — an unanswered `resolveGatewayBase`
// threw the pairing-wall copy at a member whose phone was, on disk, fully
// paired and fully populated. A plan may only end in the pairing wall when this
// module has looked at every persisted identity there is and found none.

/** A (gateway, vault) pair durable enough to name a replica database. */
export interface PersistedMountIdentity {
  gatewayId: string;
  vaultId: string;
}

export interface MountPlanInput {
  /**
   * The active `VaultLink` from lib/vault-links — the registry row a paired
   * device carries. Its `vaultId` is `''` while a freshly paired gateway's
   * enrolled vault is still resolving, which is exactly the case that has to
   * fall through to a probe.
   */
  link?: { gatewayId?: string; vaultId?: string };
  /**
   * `LAST_BASE`: the last origin that answered. A tunnel loopback port is
   * ephemeral, so this is a HINT, not an identity — phase B overwrites it the
   * moment a live base resolves, and nothing keyed on it may be durable.
   */
  cachedBase: string;
  /**
   * `LAST_GATEWAY` / `LAST_VAULT`: the active-slot projection vault-links
   * writes beside the registry. A second copy of the same fact, kept because it
   * survives a registry row that is present but incomplete, and because a
   * persisted identity is what stands between a member and the pairing wall.
   */
  lastIdentity?: PersistedMountIdentity;
}

export type MountPlan =
  | ({ kind: "open"; baseUrl: string } & PersistedMountIdentity)
  | { kind: "probe" };

/** Both halves present — a half-known tuple cannot name a replica database. */
function complete(
  identity: { gatewayId?: string; vaultId?: string } | undefined
): PersistedMountIdentity | undefined {
  return identity?.gatewayId && identity.vaultId
    ? { gatewayId: identity.gatewayId, vaultId: identity.vaultId }
    : undefined;
}

/**
 * What to mount, decided from persisted state only.
 *
 * Synchronous on purpose. There is no `await` in this function and there must
 * never be one: an async phase A is a phase A that can hang, which is the whole
 * defect this module was extracted to make impossible.
 *
 * The registry row wins over the active-slot projection when both are complete.
 * They agree in every normal case (`projectActiveSlot` writes the slot FROM the
 * row); when they disagree the row is the newer of the two, since switching a
 * VaultLink writes the row first.
 */
export function planMount(input: MountPlanInput): MountPlan {
  const identity = complete(input.link) ?? complete(input.lastIdentity);
  if (!identity) return { kind: "probe" };
  return { kind: "open", baseUrl: input.cachedBase, ...identity };
}
