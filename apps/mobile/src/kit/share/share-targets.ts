import { isAddressablePartyKind } from "@centraid/blueprints/apps/_shared/party-kind";
import {
  selectedShareMembers,
  selectionsForCircle,
} from "@centraid/blueprints/apps/_shared/share-kit";

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
  labelA?: string | null;
  labelB?: string | null;
  approved: boolean;
  revoked: boolean;
}

export type NativeShareParty = Readonly<Record<string, unknown>>;

export interface NativeShareTarget {
  id: string;
  label: string;
  partyId: string;
  vaultId: string;
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
  return selectedShareMembers(targets, selections);
}

export function selectionsForNativeCircle(
  targets: readonly NativeShareTarget[],
  circle: NativeNamedShareCircle
): Record<string, "read" | "read+write"> {
  return selectionsForCircle(targets, circle);
}

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
): { partyId: string; vaultId: string; label: string | null } | undefined {
  if (!link.approved || link.revoked) return undefined;
  if (link.vaultA === sourceVaultId && link.partyIdB)
    return {
      partyId: link.partyIdB,
      vaultId: link.vaultB,
      label: link.labelB ?? null,
    };
  if (link.vaultB === sourceVaultId && link.partyIdA)
    return {
      partyId: link.partyIdA,
      vaultId: link.vaultA,
      label: link.labelA ?? null,
    };
  return undefined;
}

export function nativeShareTargets(input: {
  sourceVaultId: string;
  ownerPartyId?: string;
  parties: readonly NativeShareParty[];
  links: readonly NativeShareLink[];
  scopes: readonly NativeShareScope[];
}): NativeShareTarget[] {
  const mounted = new Set(input.scopes.map((scope) => scope.vaultId));
  const linkedByParty = new Map<
    string,
    { vaultId: string; label: string | null }
  >();
  for (const link of input.links) {
    const peer = otherSide(link, input.sourceVaultId);
    if (peer)
      linkedByParty.set(peer.partyId, {
        vaultId: peer.vaultId,
        label: peer.label,
      });
  }
  const seen = new Set<string>();
  const refused = new Set<string>();
  const people = input.parties.flatMap((row) => {
    const partyId = typeof row.party_id === "string" ? row.party_id.trim() : "";
    const label =
      typeof row.display_name === "string" ? row.display_name.trim() : "";
    if (!partyId) return [];
    if (partyId === input.ownerPartyId || !isAddressablePartyKind(row.kind)) {
      refused.add(partyId);
      return [];
    }
    if (!label || seen.has(partyId)) return [];
    seen.add(partyId);
    const peer = linkedByParty.get(partyId);
    if (!peer || mounted.has(peer.vaultId)) return [];
    return [{ id: peer.vaultId, partyId, vaultId: peer.vaultId, label }];
  });
  const linkedOnly = [...linkedByParty].flatMap(([partyId, peer]) => {
    if (seen.has(partyId) || refused.has(partyId) || mounted.has(peer.vaultId))
      return [];
    return [
      {
        id: peer.vaultId,
        partyId,
        vaultId: peer.vaultId,
        label: peer.label?.trim() ? peer.label.trim() : "Linked person",
      },
    ];
  });
  return [...people, ...linkedOnly];
}
