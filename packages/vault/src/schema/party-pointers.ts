export type PartyPointerCollision = "revoke" | "delete";

export interface PartyPointer {
  table: string;
  column: string;
  predicate?: string;
  collision: PartyPointerCollision;
  note: string;
}

export const PARTY_POINTER_REGISTRY: readonly PartyPointer[] = [
  {
    table: "share_authority",
    column: "principal_id",
    predicate: "principal_kind = 'person'",
    collision: "revoke",
    note: "The authority plane is polymorphic on BOTH sides, so `principal_id` holds a party id, a circle id, an engine class or a device id depending on `principal_kind`. A standing grant left naming the folded-in party cannot be resolved to a peer vault, so a share the owner already granted stops being delivered.",
  },
  {
    table: "share_commons_invitation",
    column: "member_party_id",
    collision: "delete",
    note: "A pending invitation names the party it is addressed to. Left behind, the ask can never be matched to the person it was for, and `UNIQUE (grant_id, member_party_id)` no longer does its job: the two ids are different rows, so one person ends up holding two open invitations to the same commons.",
  },
];
