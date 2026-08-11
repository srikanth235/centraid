export interface NativeShareScope {
  vaultId: string;
  label: string;
  canWrite: boolean;
}

export interface NativeShareLink {
  vaultA: string;
  vaultB: string;
  partyIdA?: string | null;
  partyIdB?: string | null;
  approved: boolean;
  revoked: boolean;
}

export type NativeShareParty = Readonly<Record<string, unknown>>;

export interface NativeShareTarget {
  id: string;
  label: string;
  partyId?: string;
  vaultId?: string;
}

export interface NativeShareMember {
  partyId?: string;
  vaultId?: string;
  capability: "read" | "read+write";
}

export interface NativeNamedShareCircle {
  circleId: string;
  label: string;
  members: NativeShareMember[];
}

export function selectedNativeShareMembers(
  targets: readonly NativeShareTarget[],
  selections: Readonly<Record<string, "read" | "read+write">>
): NativeShareMember[] {
  return targets.flatMap((target) => {
    const capability = selections[target.id];
    if (!capability) return [];
    return [
      {
        ...(target.partyId ? { partyId: target.partyId } : {}),
        ...(target.vaultId ? { vaultId: target.vaultId } : {}),
        capability,
      },
    ];
  });
}

export function selectionsForNativeCircle(
  targets: readonly NativeShareTarget[],
  circle: NativeNamedShareCircle
): Record<string, "read" | "read+write"> {
  const byParty = new Map(
    circle.members.flatMap((member) =>
      member.partyId ? [[member.partyId, member.capability] as const] : []
    )
  );
  return Object.fromEntries(
    targets.flatMap((target) => {
      const capability = target.partyId
        ? byParty.get(target.partyId)
        : undefined;
      return capability ? [[target.id, capability]] : [];
    })
  );
}

/** Only current-owner Tally-decorated circles are deliberate named audiences.
 * Implicit circles have no group row; projected circles have another owner;
 * incomplete directory rosters cannot be submitted exactly. */
export function nativeNamedShareCircles(input: {
  circles: readonly NativeShareParty[];
  members: readonly NativeShareParty[];
  groups: readonly NativeShareParty[];
  targets: readonly NativeShareTarget[];
  ownerPartyId?: string;
}): NativeNamedShareCircle[] {
  if (!input.ownerPartyId) return [];
  const owned = new Set(
    input.circles.flatMap((row) =>
      typeof row.circle_id === "string" &&
      row.owner_party_id === input.ownerPartyId
        ? [row.circle_id]
        : []
    )
  );
  const reusable = new Set(
    input.groups.flatMap((row) =>
      typeof row.circle_id === "string" && owned.has(row.circle_id)
        ? [row.circle_id]
        : []
    )
  );
  const targetByParty = new Map(
    input.targets.flatMap((target) =>
      target.partyId ? [[target.partyId, target] as const] : []
    )
  );
  const byCircle = new Map<string, NativeShareMember[]>();
  const incomplete = new Set<string>();
  for (const row of input.members) {
    const circleId =
      typeof row.circle_id === "string" ? row.circle_id : undefined;
    const partyId = typeof row.party_id === "string" ? row.party_id : undefined;
    if (!circleId || !reusable.has(circleId) || !partyId) continue;
    if (partyId === input.ownerPartyId) continue;
    const target = targetByParty.get(partyId);
    if (!target) {
      incomplete.add(circleId);
      continue;
    }
    const list = byCircle.get(circleId) ?? [];
    list.push({
      partyId,
      capability: row.capability === "read+write" ? "read+write" : "read",
      ...(target.vaultId ? { vaultId: target.vaultId } : {}),
    });
    byCircle.set(circleId, list);
  }
  return input.circles.flatMap((row) => {
    const circleId =
      typeof row.circle_id === "string" ? row.circle_id : undefined;
    const label = typeof row.name === "string" ? row.name.trim() : "";
    return circleId &&
      reusable.has(circleId) &&
      !incomplete.has(circleId) &&
      label
      ? [{ circleId, label, members: byCircle.get(circleId) ?? [] }]
      : [];
  });
}

function otherSide(
  link: NativeShareLink,
  sourceVaultId: string
): { partyId: string; vaultId: string } | undefined {
  if (!link.approved || link.revoked) return undefined;
  if (link.vaultA === sourceVaultId && link.partyIdB)
    return { partyId: link.partyIdB, vaultId: link.vaultB };
  if (link.vaultB === sourceVaultId && link.partyIdA)
    return { partyId: link.partyIdA, vaultId: link.vaultA };
  return undefined;
}

/** Merge the People directory with accepted links. A person remains selectable
 * before a link/vault exists; that target compiles to an invitation only. */
export function nativeShareTargets(input: {
  sourceVaultId: string;
  ownerPartyId?: string;
  parties: readonly NativeShareParty[];
  links: readonly NativeShareLink[];
  scopes: readonly NativeShareScope[];
}): NativeShareTarget[] {
  const mounted = new Set(input.scopes.map((scope) => scope.vaultId));
  const linkedByParty = new Map<string, string>();
  for (const link of input.links) {
    const peer = otherSide(link, input.sourceVaultId);
    if (peer) linkedByParty.set(peer.partyId, peer.vaultId);
  }
  const seen = new Set<string>();
  const people = input.parties.flatMap((row) => {
    const partyId = typeof row.party_id === "string" ? row.party_id.trim() : "";
    const label =
      typeof row.display_name === "string" ? row.display_name.trim() : "";
    if (
      !partyId ||
      !label ||
      partyId === input.ownerPartyId ||
      seen.has(partyId)
    )
      return [];
    seen.add(partyId);
    const vaultId = linkedByParty.get(partyId);
    if (vaultId && mounted.has(vaultId)) return [];
    return [
      {
        id: vaultId ?? `party:${partyId}`,
        partyId,
        label,
        ...(vaultId ? { vaultId } : {}),
      },
    ];
  });
  const linkedOnly = [...linkedByParty].flatMap(([partyId, vaultId]) => {
    if (seen.has(partyId) || mounted.has(vaultId)) return [];
    return [
      {
        id: vaultId,
        partyId,
        vaultId,
        label: `Linked person ${vaultId.length > 10 ? `${vaultId.slice(0, 8)}…` : vaultId}`,
      },
    ];
  });
  return [...people, ...linkedOnly];
}
