// The shared laws are the single source of truth for what a share submits.
// Native re-states only the parts whose INPUTS differ (two-sided links, vault
// scopes); everything whose types line up delegates here rather than keeping a
// second copy that can drift (#776).
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
  /** Each vault's OWN name, from the gateway's vault directory (#750).
   *  Symmetric with vaultA/vaultB: `labelA` names `vaultA`. */
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
  /** The peer's own vault, from an approved link. Every target has one — see
   * `nativeShareTargets`. */
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

/** The shared law verbatim: a target is exactly a `ShareDestination`, so the
 * member array — including its refusal to submit a pending overlay id — is
 * computed once, in `_shared/share-kit`. */
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

/**
 * Who this vault can reach, which is exactly who it is LINKED to.
 *
 * A share is delivered into the receiver's own vault, so an approved vault
 * link is the whole mechanism: without one there is nowhere to deliver, and a
 * row offering to reach someone unreachable is a promise the product cannot
 * keep. The People directory supplies the NAME (and the ordering members
 * recognise); the link supplies the address, and a party with no link is not
 * a share target at all.
 */
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
  // Parties the DIRECTORY ruled out, kept apart from `seen` so the linked-only
  // pass below cannot resurrect them. A missing display name is not a ruling —
  // that row still belongs in the sheet, unnamed — but the member's own party
  // and a non-addressable kind are, and a recognition agent that happens to
  // carry a link would otherwise walk back in as "Linked person", which is the
  // exact row `isAddressablePartyKind` exists to keep out.
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
    // A vault this device has MOUNTED is one of the member's own, not another
    // person: sharing into it is a copy between your vaults, not a reach.
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
        // The linked vault's OWN name, carried on the link (#750). A
        // truncated vault id is not a name and is no longer offered as one —
        // when the directory holds none, the sheet says so plainly.
        label: peer.label?.trim() ? peer.label.trim() : "Linked person",
      },
    ];
  });
  return [...people, ...linkedOnly];
}
