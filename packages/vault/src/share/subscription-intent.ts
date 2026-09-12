/*
 * EDIT IS A SIGNED REPLICA INTENT (#929). A member with an `edit` grant does
 * not write into their own copy and hope it converges: they send an intent the
 * ORIGIN executes as the single writer of the container.
 *
 * Three things make that safe and legible:
 *   ATTRIBUTION — the member's vault signs the canonical payload with its
 *     Ed25519 identity key, so the receipt the origin writes names the member
 *     and not the owner whose credential executed it;
 *   ROUTING — which container a write addresses is DECLARED
 *     (`container-routing.ts`), never inferred from a command's name, so a
 *     routed-but-undeclared command is refused BY NAME rather than landing as
 *     a private mutation the next pass reverts;
 *   ONE WRITER — the origin executes; the member's seat holds a pending row
 *     until its replica carries the origin's answer.
 */

import { routeShareGrantEdit } from "../grant/fulfillment-edit.js";
import type { ShareGrantEditRoute } from "../grant/fulfillment-edit.js";
import type { ShareGrantRecord } from "../grant/grant-store.js";
import { resolveGrantAudienceParties } from "../grant/grant-store.js";
import { verifyVaultIdentitySignature } from "../schema/vault-identity.js";
import type { ShareVaultRef } from "./placement.js";

/** What a member's seat signs. Canonical, so both ends hash the same bytes. */
export interface MemberIntentEnvelope {
  intentId: string;
  shapeId: string;
  originVaultId: string;
  memberVaultId: string;
  appId: string;
  action: string;
  input: unknown;
  /** ORIGIN row versions the member composed against. */
  baseVersions?: readonly {
    shapeId?: string;
    entity: string;
    rowId: string;
    version: number;
  }[];
  /**
   * WHEN THIS ENVELOPE STOPS BEING AN OFFER (#1014, V7). A signed member
   * intent used to be good forever: anything that captured one — a relay, a
   * backup of the member's outbox, a log — could present it again months
   * later and the origin would run it. An expiry inside the SIGNED bytes is
   * what makes the replay window finite, and it has to be signed or the
   * replayer simply edits it.
   */
  expiresAt?: string;
  /**
   * A per-send random string, also signed. It costs nothing and it means two
   * envelopes that are otherwise identical — the same member re-composing the
   * same edit against the same base — are distinguishable byte for byte, so a
   * captured signature can never stand in for a later one.
   */
  nonce?: string;
}

/** How long a member's signed envelope stays presentable (#1014, V7). */
export const MEMBER_INTENT_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * Has this envelope aged out of its own window?
 *
 * An envelope that states no expiry is NOT expired: `expiresAt` is a trailing
 * field the bytes only carry when it is present (see `memberIntentBytes`), so
 * a peer built before #1014 keeps working exactly as it did. A peer that
 * states one is held to it.
 */
export function memberIntentExpired(
  envelope: MemberIntentEnvelope,
  now: Date = new Date()
): boolean {
  if (envelope.expiresAt === undefined) return false;
  const at = new Date(envelope.expiresAt).getTime();
  // An unparseable instant is not a licence to run forever.
  if (Number.isNaN(at)) return true;
  return at <= now.getTime();
}

/**
 * The signed bytes. Field ORDER is fixed here rather than taken from the
 * object's own key order: a signature over `JSON.stringify(payload)` verifies
 * whatever key order the sender happened to use, which is a signature over a
 * string rather than over a meaning.
 */
export function memberIntentBytes(envelope: MemberIntentEnvelope): Buffer {
  const canonical = JSON.stringify([
    "centraid.member-intent.v1",
    envelope.intentId,
    envelope.shapeId,
    envelope.originVaultId,
    envelope.memberVaultId,
    envelope.appId,
    envelope.action,
    envelope.input ?? null,
    (envelope.baseVersions ?? []).map((version) => [
      version.shapeId ?? "",
      version.entity,
      version.rowId,
      version.version,
    ]),
    // THE WINDOW RIDES ONLY WHEN IT IS STATED (#1014, V7). Appended as a
    // trailing pair rather than always present, so an envelope from a peer
    // that predates the replay window signs and verifies exactly the bytes it
    // always did — and a replayer who STRIPS the pair off a newer envelope
    // gets the older form, whose bytes the signature does not cover.
    ...(envelope.expiresAt === undefined && envelope.nonce === undefined
      ? []
      : [[envelope.expiresAt ?? "", envelope.nonce ?? ""]]),
  ]);
  return Buffer.from(canonical, "utf8");
}

/**
 * The MEMBER's vault key, not the link's: a link says two vaults agreed to
 * hear each other, and attribution has to survive one of them being wrong
 * about which of its members composed a write.
 */
export function verifyMemberIntent(
  envelope: MemberIntentEnvelope,
  memberPublicKey: string,
  signature: string
): boolean {
  try {
    return verifyVaultIdentitySignature(
      Buffer.from(memberPublicKey, "base64"),
      memberIntentBytes(envelope),
      Buffer.from(signature, "base64")
    );
  } catch {
    // A malformed key or signature is a refusal, never a thrown error: the
    // caller is protocol code answering a peer.
    return false;
  }
}

export type MemberIntentVerdict =
  | { state: "routed"; route: ShareGrantEditRoute; grant: ShareGrantRecord }
  | { state: "refused"; reason: string };

/**
 * Does this write belong to a container the member may edit? Routing is the
 * declared table's answer and authorization is the grant's; a command the
 * table does not declare for the container is refused by name.
 */
export function judgeMemberIntent(
  origin: ShareVaultRef,
  input: {
    action: string;
    commandInput: Record<string, unknown>;
    /** Parties the member's vault is bound to in the ORIGIN's graph. */
    memberPartyIds: readonly string[];
  }
): MemberIntentVerdict {
  const route = routeShareGrantEdit(origin.vault, {
    command: input.action,
    commandInput: input.commandInput,
  });
  if (!route)
    return {
      state: "refused",
      reason: `${input.action} addresses nothing shared with you`,
    };
  const reaching = route.grants.filter((grant) =>
    grantReaches(origin, grant, input.memberPartyIds)
  );
  if (reaching.length === 0)
    return {
      state: "refused",
      reason: `${route.containerType} ${route.containerId} is not shared with you`,
    };
  const editing = reaching.find((grant) => grant.capability === "edit");
  if (!editing)
    return {
      state: "refused",
      reason: `${input.action} writes into ${route.containerType} ${route.containerId}, which is shared for view only`,
    };
  if (!route.actable)
    return {
      state: "refused",
      reason: `command ${input.action} is not declared for ${route.containerType}`,
    };
  return { state: "routed", route, grant: editing };
}

/**
 * A PARTY grant names one party; a CIRCLE grant names its live roster, and a
 * refusal standing inside that circle masks the member out of it. Reading the
 * audience id alone would let a circle grant answer for someone the roster no
 * longer holds.
 */
function grantReaches(
  origin: ShareVaultRef,
  grant: ShareGrantRecord,
  memberPartyIds: readonly string[]
): boolean {
  const audience = resolveGrantAudienceParties(origin.vault, grant);
  return audience.parties.some((partyId) => memberPartyIds.includes(partyId));
}
