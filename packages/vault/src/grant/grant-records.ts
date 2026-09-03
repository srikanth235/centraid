import type { ShareableItemType } from "../share/closure.js";

export type ShareGrantCapability = "view" | "edit";

export type ShareGrantAudienceKind = "party" | "circle";

export interface ShareGrantAudience {
  kind: ShareGrantAudienceKind;
  id: string;
}

export type ShareFulfillmentState =
  | "awaiting_channel"
  | "syncing"
  | "delivered"
  | "remove_sent"
  | "removed";

export interface ShareGrantRecord {
  grantId: string;
  audience: ShareGrantAudience;
  subjectType: ShareableItemType;
  subjectId: string;
  capability: ShareGrantCapability;
  grantedAt: string;
  revokedAt: string | null;
  grantedBy: string;
  maxSizeBytes: number | null;
}

export interface ShareFulfillmentRecord {
  grantId: string;
  peerVaultId: string;
  state: ShareFulfillmentState;
  updatedAt: string;
  detail: string | null;
  deliveredAt: string | null;
}

export interface CreateShareGrantInput {
  audience: ShareGrantAudience;
  subjectType: ShareableItemType;
  subjectId: string;
  capability: ShareGrantCapability;
  grantedAt: string;
  grantedBy: string;
  maxSizeBytes?: number | null;
}

export type CreateShareGrantResult =
  | { outcome: "created"; grantId: string; grant: ShareGrantRecord }
  | { outcome: "exists"; grantId: string; grant: ShareGrantRecord }
  | { outcome: "conflict"; grantId: string; grant: ShareGrantRecord };

export class UnofferableSubjectError extends Error {
  readonly subjectType: string;
  readonly capability: ShareGrantCapability;
  constructor(subjectType: string, capability: ShareGrantCapability) {
    super(
      `no fulfillment strategy answers ${subjectType} x ${capability}; the grant cannot be offered`
    );
    this.name = "UnofferableSubjectError";
    this.subjectType = subjectType;
    this.capability = capability;
  }
}

export interface RevokeShareGrantResult {
  outcome: "revoked" | "already-revoked" | "absent";
  fulfillment: ShareFulfillmentRecord[];
}

export type ShareGrantRow = {
  grant_id: string;
  audience_kind: string;
  audience_id: string;
  subject_type: string;
  subject_id: string;
  capability: string;
  granted_at: string;
  revoked_at: string | null;
  granted_by: string;
  max_size_bytes: number | null;
};

export type ShareFulfillmentRow = {
  grant_id: string;
  peer_vault_id: string;
  state: string;
  updated_at: string;
  detail: string | null;
  delivered_at: string | null;
};

export const PRINCIPAL_OF_AUDIENCE: Readonly<
  Record<ShareGrantAudienceKind, string>
> = {
  party: "person",
  circle: "circle",
};

function audienceKindOf(principalKind: string): ShareGrantAudienceKind {
  return principalKind === "person" ? "party" : "circle";
}

export function toGrant(row: ShareGrantRow): ShareGrantRecord {
  return {
    grantId: row.grant_id,
    audience: {
      kind: audienceKindOf(row.audience_kind),
      id: row.audience_id,
    },
    subjectType: row.subject_type as ShareableItemType,
    subjectId: row.subject_id,
    capability: row.capability as ShareGrantCapability,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    grantedBy: row.granted_by,
    maxSizeBytes: row.max_size_bytes,
  };
}

export function toFulfillment(
  row: ShareFulfillmentRow
): ShareFulfillmentRecord {
  return {
    grantId: row.grant_id,
    peerVaultId: row.peer_vault_id,
    state: row.state as ShareFulfillmentState,
    updatedAt: row.updated_at,
    detail: row.detail,
    deliveredAt: row.delivered_at,
  };
}

export const FULFILLMENT_COLUMNS = `grant_id, peer_vault_id, state, updated_at,
  detail, delivered_at`;

export const GRANT_SELECT = `SELECT a.authority_id AS grant_id,
    a.principal_kind AS audience_kind, a.principal_id AS audience_id,
    a.subject_type AS subject_type, a.subject_id AS subject_id,
    a.verb AS capability, a.granted_at AS granted_at,
    a.revoked_at AS revoked_at, a.granted_by AS granted_by,
    d.max_size_bytes AS max_size_bytes
  FROM share_authority a
  LEFT JOIN share_delivery_config d ON d.grant_id = a.authority_id
  WHERE a.principal_kind IN ('person','circle') AND a.decision = 'granted'`;
