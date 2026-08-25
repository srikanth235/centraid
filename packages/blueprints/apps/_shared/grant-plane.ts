/**
 * The grant plane as a surface reads it (#825). Three rules live here, not in
 * components: ABSENT IS NEVER EMPTY — `fulfillment: []`, `channel: null`, a
 * severed channel and `undefined` are four facts with four tokens, and unknown
 * is never a claim; THE REGISTRY DECIDES WHICH VERBS EXIST, never a hardcoded
 * list; THE WIRE IS UNTRUSTED, so every parser is total and drops a drifted row.
 */

import type { PlaceableItemType } from "./placement-registry.ts";
import { placementEntity } from "./placement-registry.ts";

export type GrantCapability = "view" | "edit";
export type GrantAudienceKind = "party" | "circle";

export interface GrantAudience {
  kind: GrantAudienceKind;
  id: string;
}

export type GrantFulfillmentState =
  | "awaiting_channel"
  | "syncing"
  | "delivered"
  | "remove_sent"
  | "removed";

export interface GrantFulfillmentRow {
  peerVaultId: string;
  state: GrantFulfillmentState;
  updatedAt: string;
  detail: string | null;
}

export interface GrantRecord {
  grantId: string;
  audience: GrantAudience;
  subjectType: string;
  subjectId: string;
  capability: GrantCapability;
  grantedAt: string;
  revokedAt: string | null;
  grantedBy: string;
  maxSizeBytes: number | null;
  fulfillment: GrantFulfillmentRow[];
}

export interface GrantSubjectOffer {
  subjectType: string;
  capabilities: readonly GrantCapability[];
}

export type GrantChannel =
  | { state: "live" | "invited" | "severed"; vaultId?: string }
  | null
  | undefined;

export interface GrantSubject {
  subjectType: string;
  subjectId: string;
  label?: string;
}

export interface GrantAudienceOption {
  kind: GrantAudienceKind;
  id: string;
  label: string;
  memberCount?: number;
}

const FULFILLMENT_STATES: readonly GrantFulfillmentState[] = [
  "awaiting_channel",
  "syncing",
  "delivered",
  "remove_sent",
  "removed",
];

function text(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseCapability(value: unknown): GrantCapability | undefined {
  return value === "view" || value === "edit" ? value : undefined;
}

function parseFulfillmentRow(value: unknown): GrantFulfillmentRow | undefined {
  const row = record(value);
  if (!row) return undefined;
  const peerVaultId = text(row, "peerVaultId");
  const state = FULFILLMENT_STATES.find((candidate) => candidate === row.state);
  if (!peerVaultId || !state) return undefined;
  return {
    peerVaultId,
    state,
    updatedAt: text(row, "updatedAt") ?? "",
    detail: typeof row.detail === "string" ? row.detail : null,
  };
}

export function parseGrant(value: unknown): GrantRecord | undefined {
  const row = record(value);
  if (!row) return undefined;
  const audience = record(row.audience);
  const kind = audience?.kind;
  const audienceId = audience ? text(audience, "id") : undefined;
  const grantId = text(row, "grantId");
  const subjectType = text(row, "subjectType");
  const subjectId = text(row, "subjectId");
  const capability = parseCapability(row.capability);
  if (
    !grantId ||
    !subjectType ||
    !subjectId ||
    !capability ||
    !audienceId ||
    (kind !== "party" && kind !== "circle")
  )
    return undefined;
  const fulfillment = Array.isArray(row.fulfillment)
    ? row.fulfillment.flatMap((entry) => {
        const parsed = parseFulfillmentRow(entry);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    grantId,
    audience: { kind, id: audienceId },
    subjectType,
    subjectId,
    capability,
    grantedAt: text(row, "grantedAt") ?? "",
    revokedAt: typeof row.revokedAt === "string" ? row.revokedAt : null,
    grantedBy: text(row, "grantedBy") ?? "",
    maxSizeBytes:
      typeof row.maxSizeBytes === "number" ? row.maxSizeBytes : null,
    fulfillment,
  };
}

export function parseGrants(value: unknown): GrantRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const grant = parseGrant(entry);
    return grant ? [grant] : [];
  });
}

export function parseSubjectOffers(value: unknown): GrantSubjectOffer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = record(entry);
    const subjectType = row ? text(row, "subjectType") : undefined;
    if (!row || !subjectType) return [];
    const capabilities = Array.isArray(row.capabilities)
      ? row.capabilities.flatMap((candidate) => {
          const capability = parseCapability(candidate);
          return capability ? [capability] : [];
        })
      : [];
    return capabilities.length ? [{ subjectType, capabilities }] : [];
  });
}

/** Only an explicit `null` is "never reached"; drift answers `undefined`, so no
 * surface paints it over a person the vault may be reaching. */
export function parseChannel(value: unknown): GrantChannel {
  if (value === null) return null;
  const row = record(value);
  if (!row) return undefined;
  const state = row.state;
  if (state !== "live" && state !== "invited" && state !== "severed")
    return undefined;
  const vaultId = text(row, "vaultId");
  return { state, ...(vaultId ? { vaultId } : {}) };
}

/** An empty answer is the refusal: do not draw Share over that subject. */
export function capabilitiesFor(
  offers: readonly GrantSubjectOffer[],
  subjectType: string
): readonly GrantCapability[] {
  return (
    offers.find((offer) => offer.subjectType === subjectType)?.capabilities ??
    []
  );
}

export function offersCapability(
  offers: readonly GrantSubjectOffer[],
  subjectType: string,
  capability: GrantCapability
): boolean {
  return capabilitiesFor(offers, subjectType).includes(capability);
}

export function subjectNoun(subjectType: string): string {
  return (
    placementEntity(subjectType as PlaceableItemType)?.label ?? "shared item"
  );
}

export type GrantDelivery = GrantFulfillmentState | "none";

/** Worst-standing state: half delivered, half waiting reads as waiting. */
export function grantDelivery(grant: GrantRecord): GrantDelivery {
  if (!grant.fulfillment.length) return "none";
  for (const state of FULFILLMENT_STATES)
    if (grant.fulfillment.some((row) => row.state === state)) return state;
  return "none";
}

/** `unknown` is an unanswered read, not a reach state; it owes a checking line. */
export type GrantReach =
  | "unknown"
  | "never-reached"
  | "invited"
  | "live"
  | "severed";

export function channelReach(channel: GrantChannel): GrantReach {
  if (channel === undefined) return "unknown";
  return channel === null ? "never-reached" : channel.state;
}

/** A revoked grant is history, not access. */
export function liveGrants(
  grants: readonly GrantRecord[]
): readonly GrantRecord[] {
  return grants.filter((grant) => grant.revokedAt === null);
}

/** A `?partyId=` read is a union, so matching on subject alone lets a circle's
 * `edit` widen a grant to the person herself. */
export function grantOverSubject(
  grants: readonly GrantRecord[],
  subject: GrantSubject,
  audience: GrantAudience | undefined
): GrantRecord | undefined {
  if (!audience) return undefined;
  return liveGrants(grants).find(
    (grant) =>
      grant.subjectType === subject.subjectType &&
      grant.subjectId === subject.subjectId &&
      grant.audience.kind === audience.kind &&
      grant.audience.id === audience.id
  );
}

/** Opening on `edit` because the registry offers it widens the proposal. */
export function defaultCapability(
  standing: GrantRecord | undefined
): GrantCapability {
  return standing?.capability ?? "view";
}

/** Clamped to what the picker could DRAW: no un-picking an undrawn verb. */
export function drawableCapability(
  capabilities: readonly GrantCapability[],
  wanted: GrantCapability
): GrantCapability {
  if (capabilities.includes(wanted)) return wanted;
  return capabilities[0] ?? "view";
}

export interface GrantRequest {
  audienceKind: GrantAudienceKind;
  audienceId: string;
  subjectType: string;
  subjectId: string;
  capability: GrantCapability;
  subjectLabel?: string;
}

export function grantRequestFor(
  audience: GrantAudienceOption,
  subject: GrantSubject,
  capability: GrantCapability
): GrantRequest {
  return {
    audienceKind: audience.kind,
    audienceId: audience.id,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    capability,
    ...(subject.label ? { subjectLabel: subject.label } : {}),
  };
}
