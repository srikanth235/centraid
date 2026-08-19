/**
 * THE GRANT PLANE, AS A SURFACE READS IT (issue #825).
 *
 * A share is a standing grant: who may see or edit which subject, from when,
 * until it is revoked. `packages/server/src/routes/grant-routes.ts` is the one
 * door; this module is the one place either seat turns that door's wire into
 * something a sheet can draw, so the web and native kits cannot drift into two
 * readings of the same answer.
 *
 * Three rules travel with the data and are enforced here rather than
 * remembered per component:
 *
 *  - ABSENT IS NEVER EMPTY. `fulfillment: []` is "no audience vault has been
 *    addressed yet", `channel: null` is "this vault has never reached them",
 *    a severed channel is a third thing again, and `channel: undefined` — not
 *    read yet, or a read that did not say — is a fourth. `grantDelivery` and
 *    `channelReach` answer each of them with its own token, never with one
 *    shared blank. UNKNOWN IS NOT A CLAIM: only a read that actually answered
 *    may produce the definite "never reached".
 *  - THE REGISTRY DECIDES WHICH VERBS EXIST. `capabilitiesFor` reads the
 *    declared subject registry the gateway serves (`…/grants/subjects`); no
 *    surface may decide from a hardcoded list which subjects take `edit`.
 *  - THE WIRE IS UNTRUSTED. Every parser here is total: a drifted row is
 *    dropped rather than rendered half-built, exactly as the mobile link
 *    transport already does for `/links`.
 *
 * Copy lives in `grant-copy.ts` — this module answers in state tokens so both
 * seats say the same sentence about the same fact.
 */

import type { PlaceableItemType } from "./placement-registry.ts";
import { placementEntity } from "./placement-registry.ts";

export type GrantCapability = "view" | "edit";
export type GrantAudienceKind = "party" | "circle";

export interface GrantAudience {
  kind: GrantAudienceKind;
  id: string;
}

/** Delivery states one grant's fulfillment rows can be in. */
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
  /** `[]` is a real answer: nothing has been addressed to a peer vault yet. */
  fulfillment: GrantFulfillmentRow[];
}

/** One row of the declared registry the gateway serves before Share is drawn. */
export interface GrantSubjectOffer {
  subjectType: string;
  capabilities: readonly GrantCapability[];
}

/**
 * How this vault can reach a person. Three answers, and the third is the one
 * a surface most easily fakes: `null` is the definite "this vault has never
 * reached them", and `undefined` is "nobody has asked yet, or the answer did
 * not say" — which is not a fact about the person at all.
 */
export type GrantChannel =
  | { state: "live" | "invited" | "severed"; vaultId?: string }
  | null
  | undefined;

/** What a subject-first sheet is opened over. */
export interface GrantSubject {
  subjectType: string;
  subjectId: string;
  /** The subject's own title, when the host has one. Never an id dressed up. */
  label?: string;
}

/** One person or circle a grant can name. */
export interface GrantAudienceOption {
  kind: GrantAudienceKind;
  id: string;
  label: string;
  /** Members, for a circle — a party option leaves it undefined. */
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

/** One wire grant, or `undefined` when the payload cannot be trusted. */
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

/** The declared registry. An unreadable row is dropped, never defaulted open. */
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

/**
 * The channel the read actually answered. Only an explicit `null` on the wire
 * is the definite "never reached" — an absent key, a non-object, or a state
 * this build does not recognise is DRIFT, and drift answers `undefined` so a
 * surface cannot paint "Not reached yet" over a person the vault may well be
 * reaching. A claim about someone's reach is only ever as good as the read.
 */
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

/**
 * Which capabilities the vault will actually stand for this subject type.
 * An empty answer is the refusal: the subject is not offerable at all, and a
 * surface must not draw Share over it.
 */
export function capabilitiesFor(
  offers: readonly GrantSubjectOffer[],
  subjectType: string
): readonly GrantCapability[] {
  return (
    offers.find((offer) => offer.subjectType === subjectType)?.capabilities ??
    []
  );
}

/** True only where the declared registry answers this subject × capability. */
export function offersCapability(
  offers: readonly GrantSubjectOffer[],
  subjectType: string,
  capability: GrantCapability
): boolean {
  return capabilitiesFor(offers, subjectType).includes(capability);
}

/**
 * The noun a member reads for a subject type ("album", "document"), from the
 * placement registry every other placement control already reads. A type the
 * registry does not name answers `item` rather than printing its wire spelling.
 */
export function subjectNoun(subjectType: string): string {
  return (
    placementEntity(subjectType as PlaceableItemType)?.label ?? "shared item"
  );
}

/** Where one grant actually got to. `none` is "addressed to nobody yet". */
export type GrantDelivery = GrantFulfillmentState | "none";

/**
 * The single worst-standing delivery state across a grant's peers — the one a
 * row can honestly show. Precedence runs from "still owed" to "settled", so a
 * grant half delivered and half waiting reads as waiting rather than done.
 */
export function grantDelivery(grant: GrantRecord): GrantDelivery {
  if (!grant.fulfillment.length) return "none";
  for (const state of FULFILLMENT_STATES)
    if (grant.fulfillment.some((row) => row.state === state)) return state;
  return "none";
}

/**
 * How this vault can reach the audience, as one token a sheet can draw.
 * `unknown` is the read that has not answered — it is not a reach state, and
 * a surface owes it a checking line rather than any of the other four.
 */
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

/** The grants still standing — a revoked grant is history, not access. */
export function liveGrants(
  grants: readonly GrantRecord[]
): readonly GrantRecord[] {
  return grants.filter((grant) => grant.revokedAt === null);
}

/**
 * The standing grant over exactly this subject FOR THIS AUDIENCE.
 *
 * The audience is not optional detail. A `?partyId=` read is a union — the
 * grants naming that person plus the circle grants she is on the roster of —
 * so matching on the subject alone would let a circle's `edit` decide what a
 * new grant to the person herself proposes, widening a decision nobody made.
 * A read with no audience in hand has no standing grant to answer with.
 */
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

/**
 * Which capability the sheet should open on: the one already standing, else
 * `view`. Opening on `edit` because the registry offers it would propose a
 * wider grant than the member asked for.
 */
export function defaultCapability(
  standing: GrantRecord | undefined
): GrantCapability {
  return standing?.capability ?? "view";
}

/**
 * The capability a sheet may actually SUBMIT: whatever the picker could draw.
 *
 * `defaultCapability` reads a grant recorded when the registry may have said
 * something else — a subject the vault has since narrowed to view-only still
 * carries its old `edit` grant — and a member cannot un-pick a verb that was
 * never drawn. Posting the unofferable one would be refused at the door with
 * a sentence about a choice the member never made, so it is clamped here.
 */
export function drawableCapability(
  capabilities: readonly GrantCapability[],
  wanted: GrantCapability
): GrantCapability {
  if (capabilities.includes(wanted)) return wanted;
  return capabilities[0] ?? "view";
}

/** The request body the create door takes, built in one place per seat. */
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
