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
 *    and a severed channel is a third thing again. `grantDelivery` and
 *    `channelReach` answer each of them with its own token, never with one
 *    shared blank.
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

/** How this vault can reach a person; `null` is "never reached", not "none". */
export type GrantChannel = {
  state: "live" | "invited" | "severed";
  vaultId?: string;
} | null;

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
 * The channel, or `null`. `undefined` on the wire is also `null` here: a read
 * that did not say is the same fact as a vault that has never reached them,
 * and neither is a severed link.
 */
export function parseChannel(value: unknown): GrantChannel {
  const row = record(value);
  if (!row) return null;
  const state = row.state;
  if (state !== "live" && state !== "invited" && state !== "severed")
    return null;
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

/** How this vault can reach the audience, as one token a sheet can draw. */
export type GrantReach = "never-reached" | "invited" | "live" | "severed";

export function channelReach(channel: GrantChannel): GrantReach {
  return channel === null ? "never-reached" : channel.state;
}

/** The grants still standing — a revoked grant is history, not access. */
export function liveGrants(
  grants: readonly GrantRecord[]
): readonly GrantRecord[] {
  return grants.filter((grant) => grant.revokedAt === null);
}

/** The standing grant over exactly this subject, if the audience has one. */
export function grantOverSubject(
  grants: readonly GrantRecord[],
  subject: GrantSubject
): GrantRecord | undefined {
  return liveGrants(grants).find(
    (grant) =>
      grant.subjectType === subject.subjectType &&
      grant.subjectId === subject.subjectId
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
