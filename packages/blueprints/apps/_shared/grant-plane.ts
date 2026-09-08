/**
 * The grant plane as a surface reads it (#825). ABSENT IS NEVER EMPTY: the
 * types keep empty, null, severed and unknown apart, and unknown is never a
 * claim. THE REGISTRY DECIDES WHICH VERBS EXIST. THE WIRE IS UNTRUSTED — every
 * parser is total and drops a drifted row. THE VAULT
 * SAYS WHERE A GRANT STANDS (#883, ruling V-phrases): `phrase`, `reason` and
 * `confirmed` ride the wire, derived once in the vault.
 */

import { GRANT_LOCI } from "./grant-transport.ts";
import type {
  GrantAudienceKind,
  GrantCapability,
  GrantLocus,
  GrantRequest,
} from "./grant-transport.ts";
import { placementEntity } from "./placement-registry.ts";
import type { PlaceableItemType } from "./placement-registry.ts";

export { GRANT_LOCI } from "./grant-transport.ts";
export type {
  GrantAudienceKind,
  GrantCapability,
  GrantLocus,
  GrantRequest,
} from "./grant-transport.ts";

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

/** Mirror of the vault's `GRANT_PHRASES`; `grant-plane.test.ts` source-scans
 *  it. `@centraid/vault` is Node-only. */
export const GRANT_PHRASES = ["on its way", "shared", "withdrawn"] as const;
export type GrantPhrase = (typeof GRANT_PHRASES)[number];

export function parseLocus(value: unknown): GrantLocus | undefined {
  return GRANT_LOCI.find((candidate) => candidate === value);
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
  phrase?: GrantPhrase;
  reason: string | null;
  /** `withdrawn` only: false until the audience acknowledged the removal. */
  confirmed?: boolean;
  locus?: GrantLocus;
  promise?: string;
}

export interface GrantSubjectOffer {
  subjectType: string;
  capabilities: readonly GrantCapability[];
}

export type GrantChannel =
  | { state: "live" | "severed"; vaultId?: string }
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
  // Drift drops to `undefined`, never a neighbouring word: a guess would print
  // a claim the vault did not make.
  const phrase = GRANT_PHRASES.find((candidate) => candidate === row.phrase);
  const locus = parseLocus(row.locus);
  const promise = text(row, "promise");
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
    ...(phrase ? { phrase } : {}),
    reason: text(row, "reason") ?? null,
    ...(typeof row.confirmed === "boolean" ? { confirmed: row.confirmed } : {}),
    ...(locus ? { locus } : {}),
    ...(promise ? { promise } : {}),
  };
}

export function parseGrants(value: unknown): GrantRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const grant = parseGrant(entry);
    return grant ? [grant] : [];
  });
}

export function parseLoci(value: unknown): Partial<Record<GrantLocus, string>> {
  const row = record(value);
  if (!row) return {};
  const loci: Partial<Record<GrantLocus, string>> = {};
  for (const locus of GRANT_LOCI) {
    const copy = text(row, locus);
    if (copy) loci[locus] = copy;
  }
  return loci;
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

/** Only an explicit `null` is "never reached"; drift answers `undefined`. */
export function parseChannel(value: unknown): GrantChannel {
  if (value === null) return null;
  const row = record(value);
  if (!row) return undefined;
  const state = row.state;
  if (state !== "live" && state !== "severed") return undefined;
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

export function subjectNoun(subjectType: string): string {
  return (
    placementEntity(subjectType as PlaceableItemType)?.label ?? "shared item"
  );
}

export type GrantReach = "unknown" | "never-reached" | "live" | "severed";

export function channelReach(channel: GrantChannel): GrantReach {
  if (channel === undefined) return "unknown";
  return channel === null ? "never-reached" : channel.state;
}

/**
 * Whether this reach makes the share verb an act the surface cannot perform
 * (#903): a person is reachable only through a live link, and the command pack
 * refuses the rest, so offering the submit would name a promise nothing keeps.
 *
 * `unknown` deliberately does NOT block. "We could not look" is not "they are
 * not linked", and a denied channel read must never disable a control the
 * member is in fact entitled to use — the route stays the authority, and it
 * answers in words if the guess here was generous.
 */
export function reachBlocksSharing(reach: GrantReach): boolean {
  return reach === "never-reached" || reach === "severed";
}

/**
 * Whether the sheet offers the LINK-TICKET ceremony inline (#929 S6).
 *
 * #903's rule is untouched: a person is reachable only through a live link, the
 * submit still refuses, and nothing is sent on the member's behalf. What
 * changes is that the refusal stops being a dead end — the one act that would
 * make this share possible is offered where the member already is, through the
 * same one-time ticket People and Settings mint. A circle is not a person and
 * has no link to make, and `unknown` is not a refusal, so neither is offered
 * the ceremony.
 */
export function offersLinkTicket(
  audienceKind: GrantAudience["kind"] | undefined,
  reach: GrantReach
): boolean {
  return audienceKind === "party" && reachBlocksSharing(reach);
}

/** A ticket the gateway minted: opaque string plus the expiry IT decided. */
export interface MintedLinkTicket {
  ticket: string;
  expiresAt: string;
}

/**
 * Mint one through the ceremony that already exists — `peer_link_tickets`
 * behind POST `…/links/ticket`, the same route the People and Settings link
 * rows use. No new gateway surface; a refusal comes back as the words the
 * member reads, never as a thrown stack.
 */
export type LinkTicketDoor = () => Promise<
  { ok: true; ticket: MintedLinkTicket } | { ok: false; message: string }
>;

/** The wire shape, guarded once so neither seat reads a payload itself. */
export function parseMintedLinkTicket(
  body: unknown
): MintedLinkTicket | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const row = body as { ticket?: unknown; expiresAt?: unknown };
  return typeof row.ticket === "string" && typeof row.expiresAt === "string"
    ? { ticket: row.ticket, expiresAt: row.expiresAt }
    : undefined;
}

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
