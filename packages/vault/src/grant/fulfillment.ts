/*
 * START, STOP, REPORT (#929). A grant is kept true by a SUBSCRIPTION, not by
 * the origin reaching into an audience vault: this module decides who should
 * hold the grant's rows and hands each audience its three outputs. The transport is the only
 * thing that knows whether the audience is co-hosted (loopback) or on another
 * gateway (the peer replica route), which is what makes one delivery path
 * serve both — the reach that confined cross-gateway sharing to a second rail.
 *
 * Origin-authoritative throughout: the audience never authors over a projected
 * row, and revocation settles `removed` only on the seat's acknowledgement.
 */

import { shareOutputsAreEmpty } from "../share/closure-outputs.js";
import type { ShareVaultRef } from "../share/placement.js";
import { assertShareCeiling } from "../share/share-ceiling.js";
import {
  readSubscription,
  recordSubscription,
} from "../share/subscription-store.js";
import type {
  ShareTailFrame,
  ShareTailPass,
} from "../share/subscription-tail.js";
import { composeShareTail } from "../share/subscription-tail.js";
import { channelForParty } from "./channel.js";
import type { ShareFulfillmentState, ShareGrantRecord } from "./grant-store.js";
import {
  listFulfillment,
  readFulfillment,
  readShareGrant,
  resolveGrantAudienceParties,
  setFulfillmentState,
} from "./grant-store.js";

export type ShareTransportRoute = "loopback" | "peer";

export type ShareDeliveryOutcome =
  | {
      /**
       * The audience holds rows it wrote over the origin's. Not a failure and
       * not a delivery: the caller resends the whole membership, which is what
       * erases them (ruling G-view, #846; #996 R10 keeps the property while
       * moving the mechanism off "re-read everything, every pass").
       */
      outcome: "diverged";
      diverged: number;
    }
  | {
      outcome: "delivered";
      /** What the audience had to write — the work-counter reading (#927). */
      entered: number;
      updated: number;
      left: number;
    }
  | { outcome: "unreachable"; detail: string };

export type ShareRemovalOutcome =
  | { outcome: "acknowledged"; removed: number; retained: number }
  | { outcome: "unreachable"; detail: string };

/**
 * One audience seat, however it is reached. `deliver` places the manifest's
 * bytes and ingests the frame; `remove` drops the shape and ANSWERS — that
 * acknowledgement is what settles `removed`, so an unanswered removal stops at
 * `remove_sent` whether the seat is a hardlink away or a gateway away.
 */
export interface ShareShapeTransport {
  route: ShareTransportRoute;
  deliver: (frame: ShareTailFrame) => ShareDeliveryOutcome;
  remove: (input: {
    /** The GRANT (#996, R10): the grant is the shape. */
    authorityId: string;
    audienceVaultId: string;
  }) => ShareRemovalOutcome;
}

export interface ShareSubscriptionStep {
  partyId: string;
  state: ShareFulfillmentState;
  peerVaultId?: string;
  route?: ShareTransportRoute;
  detail?: string;
  /** What the audience wrote — the three outputs' own counts (#996, R10). */
  entered?: number;
  updated?: number;
  left?: number;
  /** Already matched: nothing composed, nothing written, no device woken. */
  unchanged?: true;
  /** The FIRST time the subject reached this peer (#846). */
  firstDelivery?: true;
}

export interface ShareSubscriptionResult {
  grantId: string;
  shapeId: string;
  steps: readonly ShareSubscriptionStep[];
  /**
   * `masked` is a refusal standing inside a granted circle; `departed` is a
   * peer still holding a delivered copy whose party left the roster — that copy
   * ends by revocation, not a roster edit, so the receipt carries it.
   */
  drift: {
    masked: readonly string[];
    departed: readonly { partyId: string; peerVaultId: string }[];
  };
}

/*
 * THE HOST-MEMORY DIGEST IS GONE (#996, R10). Its one job was to stop an
 * unchanged shape reaching a transport, and the member set answers that
 * question better and durably: a pass whose three outputs are all empty IS an
 * unchanged subscription, decided from origin state rather than from a cache
 * a restart empties. `share_subscription_member` is its successor, so nothing
 * was deleted without one.
 */

/** Grant-keyed shape id. Mirrors `@centraid/core/protocol`'s `shareShapeId`;
 *  the peer replica route's test holds the two equal. */
export function shareGrantShapeId(grantId: string): string {
  return `@share:${grantId}`;
}

export interface StartShareSubscriptionInput {
  origin: ShareVaultRef;
  originVaultId: string;
  grantId: string;
  /** A fact about REACH, never about the grant. */
  transportFor: (peerVaultId: string) => ShareShapeTransport | undefined;
  now: string;
}

/**
 * No open channel, so nothing is carried and nothing is minted to open one
 * (#903). A SEVERED link names a vault and writes a row; a party who was never
 * linked has no vault to name and writes none.
 */
function park(input: {
  origin: ShareVaultRef;
  grantId: string;
  partyId: string;
  peerVaultId?: string;
  now: string;
}): ShareSubscriptionStep {
  const detail =
    input.peerVaultId === undefined
      ? "they have no linked account, so there is no vault to deliver into"
      : `the link to peer vault ${input.peerVaultId} has ended`;
  // An UPDATE, never an insert-if-absent: a severed link must DEMOTE a row that
  // already read `delivered`. The durable memory is untouched (#846), so a peer
  // that was delivered to still owes its copy back on revocation.
  if (input.peerVaultId !== undefined)
    setFulfillmentState(input.origin.vault, {
      grantId: input.grantId,
      peerVaultId: input.peerVaultId,
      state: "awaiting_channel",
      updatedAt: input.now,
      detail,
    });
  return {
    partyId: input.partyId,
    state: "awaiting_channel",
    ...(input.peerVaultId === undefined
      ? {}
      : { peerVaultId: input.peerVaultId }),
    detail,
  };
}

/**
 * ONE PASS PER AUDIENCE, and no longer one composition per grant (#996, R10).
 *
 * The frame composer was audience-independent — the only thing an audience
 * contributed was the vault id it was addressed to — so one composition could
 * be re-stamped for everyone. A TAIL is not: it is the difference since THIS
 * audience's cursor, and re-stamping one audience's diff onto another would
 * hand the second a set of rows computed against a position it is not at.
 * The cost is one closure walk per audience rather than one per pass, over a
 * roster that is a circle's members.
 *
 * `undefined` means the row applier cannot place this closure — today only a
 * Locker item, whose sealed columns must be re-sealed under the audience DEK
 * inside one process. Such a grant was never deliverable over a subscription
 * (the ingest had no keys to re-seal with and threw); now it parks with the
 * reason said out loud instead.
 */
function passFor(
  input: StartShareSubscriptionInput,
  grant: ShareGrantRecord,
  audienceVaultId: string,
  options: { resend?: boolean } = {}
): ShareTailPass | undefined {
  const standing = options.resend
    ? undefined
    : readSubscription(input.origin.vault, grant.grantId, audienceVaultId);
  return composeShareTail({
    origin: input.origin.vault,
    originVaultId: input.originVaultId,
    audienceVaultId,
    authorityId: grant.grantId,
    subjectType: grant.subjectType,
    subjectId: grant.subjectId,
    maxSizeBytes: grant.maxSizeBytes,
    ...(standing?.cursor.epoch == null
      ? {}
      : {
          since: { epoch: standing.cursor.epoch, seq: standing.cursor.seq },
        }),
  });
}

const UNPLACEABLE_DETAIL =
  "this grant's closure carries rows the audience cannot place as rows";

/** Idempotent. A departed member's copy ends by revocation, never by drift. */
export function startShareSubscription(
  input: StartShareSubscriptionInput
): ShareSubscriptionResult {
  const db = input.origin.vault;
  const grant = readShareGrant(db, input.grantId);
  if (!grant) throw new Error(`share grant ${input.grantId} is not available`);
  if (grant.revokedAt !== null)
    throw new Error(
      `share grant ${input.grantId} is revoked; stop its subscriptions instead`
    );
  // JUDGED ONCE, BEFORE ANY AUDIENCE. An over-ceiling grant leaves no
  // fulfillment row and dials no transport, including when every peer is
  // unreachable — a check inside the loop would skip exactly that case.
  assertShareCeiling(db, {
    authorityId: grant.grantId,
    originVaultId: input.originVaultId,
    subjectType: grant.subjectType,
    subjectId: grant.subjectId,
    maxSizeBytes: grant.maxSizeBytes,
  });
  const steps: ShareSubscriptionStep[] = [];
  const audience = resolveGrantAudienceParties(db, grant);
  const reached = new Map<string, string>();
  for (const partyId of audience.parties) {
    if (partyId === grant.grantedBy) continue;
    const channel = channelForParty(db, partyId);
    // On the roster and addressable: ours to keep, whatever its state.
    if (channel) reached.set(channel.vaultId, partyId);
    if (channel?.state !== "live") {
      steps.push(
        park({
          origin: input.origin,
          grantId: grant.grantId,
          partyId,
          ...(channel === null ? {} : { peerVaultId: channel.vaultId }),
          now: input.now,
        })
      );
      continue;
    }
    const peerVaultId = channel.vaultId;
    // COMPOSED BEFORE REACH IS CONSULTED, deliberately: the ceiling is a
    // property of the GRANT, so an over-ceiling subject must leave no
    // fulfillment row and dial nothing whether or not a transport exists.
    // Composing after the reach check would make an unreachable peer the one
    // case where the ceiling is not judged.
    const pass = passFor(input, grant, peerVaultId);
    const transport = input.transportFor(peerVaultId);
    if (!transport) {
      // Channel open, this host cannot carry it now: `syncing` is honest.
      const detail = `peer vault ${peerVaultId} is not reachable from this host`;
      setFulfillmentState(db, {
        grantId: grant.grantId,
        peerVaultId,
        state: "syncing",
        updatedAt: input.now,
        detail,
      });
      steps.push({ partyId, state: "syncing", peerVaultId, detail });
      continue;
    }
    const standing = readFulfillment(db, grant.grantId, peerVaultId);
    if (!pass) {
      setFulfillmentState(db, {
        grantId: grant.grantId,
        peerVaultId,
        state: "syncing",
        updatedAt: input.now,
        detail: UNPLACEABLE_DETAIL,
      });
      steps.push({
        partyId,
        state: "syncing",
        peerVaultId,
        detail: UNPLACEABLE_DETAIL,
      });
      continue;
    }
    // DIFF FIRST, from ORIGIN STATE. A pass whose three outputs are all empty
    // is an unchanged subscription: nothing is dialled and nothing is written.
    // Consult `delivered_at` too, never the diff alone — a lost-reach row sits
    // in `syncing` with an audience that never received the copy, and its
    // membership was never settled, so its outputs would not be empty anyway.
    if (
      standing?.state === "delivered" &&
      standing.deliveredAt !== null &&
      shareOutputsAreEmpty(pass.frame.outputs)
    ) {
      steps.push({
        partyId,
        state: "delivered",
        peerVaultId,
        route: transport.route,
        unchanged: true,
      });
      continue;
    }
    setFulfillmentState(db, {
      grantId: grant.grantId,
      peerVaultId,
      state: "syncing",
      updatedAt: input.now,
    });
    let delivery = transport.deliver(pass.frame);
    if (delivery.outcome === "diverged") {
      // ONE RESEND, in this same pass, so the divergence is erased by the pass
      // that found it rather than by the next one. `since` omitted is the
      // resend: every member goes out as an `enter`, and `entered_seq` makes
      // that an upsert on the rows the audience legitimately holds.
      const resend = passFor(input, grant, peerVaultId, { resend: true });
      delivery = resend
        ? transport.deliver(resend.frame)
        : { outcome: "unreachable", detail: UNPLACEABLE_DETAIL };
      if (resend && delivery.outcome === "delivered") resend.settle();
    }
    if (delivery.outcome === "diverged") {
      const detail = `the audience holds ${delivery.diverged} row(s) it wrote over the origin's`;
      setFulfillmentState(db, {
        grantId: grant.grantId,
        peerVaultId,
        state: "syncing",
        updatedAt: input.now,
        detail,
      });
      steps.push({ partyId, state: "syncing", peerVaultId, detail });
      continue;
    }
    if (delivery.outcome === "unreachable") {
      setFulfillmentState(db, {
        grantId: grant.grantId,
        peerVaultId,
        state: "syncing",
        updatedAt: input.now,
        detail: delivery.detail,
      });
      steps.push({
        partyId,
        state: "syncing",
        peerVaultId,
        route: transport.route,
        detail: delivery.detail,
      });
      continue;
    }
    setFulfillmentState(db, {
      grantId: grant.grantId,
      peerVaultId,
      state: "delivered",
      updatedAt: input.now,
    });
    // SETTLED ONLY ONCE THE AUDIENCE HAS THE ROWS. Membership is what the
    // origin believes the audience holds; advancing it on a failed delivery
    // would make the next pass's `enter` empty and lose the rows silently.
    pass.settle();
    // AND RECORDED, on the ORIGIN. `share_subscription.cursor_seq` is the
    // origin's own note of what it last served this audience: the tail door
    // compares an audience's claimed cursor against it, and the next pass
    // reads it as where to diff from.
    recordSubscription(db, {
      authorityId: grant.grantId,
      audienceVaultId: peerVaultId,
      originVaultId: input.originVaultId,
      subjectType: grant.subjectType,
      cursor: pass.frame.outputs.cursor,
      state: "subscribed",
      now: input.now,
    });
    steps.push({
      partyId,
      state: "delivered",
      peerVaultId,
      route: transport.route,
      entered: delivery.entered,
      updated: delivery.updated,
      left: delivery.left,
      // Read off the DURABLE memory as it stood BEFORE this pass (#846), so
      // the "shared with you" notice fires once per grant.
      ...(standing?.deliveredAt ? {} : { firstDelivery: true as const }),
    });
  }
  return {
    grantId: grant.grantId,
    shapeId: shareGrantShapeId(grant.grantId),
    steps,
    drift: {
      masked: audience.masked,
      departed: listFulfillment(db, grant.grantId)
        .filter(
          (row) => row.deliveredAt !== null && !reached.has(row.peerVaultId)
        )
        .map((row) => ({
          partyId: departedPartyFor(input.origin, row.peerVaultId),
          peerVaultId: row.peerVaultId,
        })),
    },
  };
}

/** `''` when the binding is gone too. */
function departedPartyFor(origin: ShareVaultRef, peerVaultId: string): string {
  const row = origin.vault
    .prepare(
      `SELECT party_id FROM share_party_vault_binding
        WHERE vault_id = ? AND revoked_at IS NULL LIMIT 1`
    )
    .get(peerVaultId) as { party_id: string } | undefined;
  return row?.party_id ?? "";
}

/**
 * A removed row clears `delivered_at` (#846), so this is the ONLY thing
 * separating "never a copy" from "the copy is gone"; the member-facing phrase
 * reads it back.
 */
export const NOTHING_DELIVERED_DETAIL =
  "nothing had been delivered; there was nothing to remove";

export interface ShareSubscriptionStopStep {
  peerVaultId: string;
  state: ShareFulfillmentState;
  detail?: string;
  removed?: number;
  retained?: number;
}

export interface ShareSubscriptionStopResult {
  grantId: string;
  shapeId: string;
  steps: readonly ShareSubscriptionStopStep[];
}

export interface StopShareSubscriptionInput {
  /**
   * The HANDLE only. Stopping settles delivery rows and dials a transport; it
   * reads no blobs and no keys, and asking for a full `ShareVaultRef` would
   * shut out the callers that hold nothing else — the one-shot migration among
   * them, which must settle a revoked answer's deliveries or leave an audience
   * holding rows the origin no longer projects.
   */
  origin: Pick<ShareVaultRef, "vault">;
  originVaultId: string;
  grantId: string;
  transportFor: (peerVaultId: string) => ShareShapeTransport | undefined;
  now: string;
}

/**
 * REVOCATION IS SHAPE REMOVAL. Nothing promotes `remove_sent` to `removed` on a
 * timer: only the seat's acknowledgement does, so a removal that left the
 * origin and was never answered reads honestly. Never-delivered ends `removed`
 * with a "nothing delivered" detail, never a fabricated "removal sent".
 */
export function stopShareSubscription(
  input: StopShareSubscriptionInput
): ShareSubscriptionStopResult {
  const db = input.origin.vault;
  const grant = readShareGrant(db, input.grantId);
  if (!grant) throw new Error(`share grant ${input.grantId} is not available`);
  if (grant.revokedAt === null)
    throw new Error(
      `share grant ${input.grantId} still stands; revoke it before stopping it`
    );
  const shapeId = shareGrantShapeId(grant.grantId);
  const steps: ShareSubscriptionStopStep[] = [];
  for (const row of listFulfillment(db, grant.grantId)) {
    if (row.state === "removed") {
      steps.push({ peerVaultId: row.peerVaultId, state: "removed" });
      continue;
    }
    // Ask `delivered_at`, not live state (#846): a lost-reach row sits in
    // `syncing` and must not settle `removed` while the audience holds a copy.
    if (row.deliveredAt === null) {
      setFulfillmentState(db, {
        grantId: grant.grantId,
        peerVaultId: row.peerVaultId,
        state: "removed",
        updatedAt: input.now,
        detail: NOTHING_DELIVERED_DETAIL,
      });
      steps.push({
        peerVaultId: row.peerVaultId,
        state: "removed",
        detail: NOTHING_DELIVERED_DETAIL,
        removed: 0,
      });
      continue;
    }
    setFulfillmentState(db, {
      grantId: grant.grantId,
      peerVaultId: row.peerVaultId,
      state: "remove_sent",
      updatedAt: input.now,
    });
    const transport = input.transportFor(row.peerVaultId);
    const answer: ShareRemovalOutcome = transport
      ? transport.remove({
          authorityId: grant.grantId,
          audienceVaultId: row.peerVaultId,
        })
      : {
          outcome: "unreachable",
          detail: `removal sent to ${row.peerVaultId}; the peer has not acknowledged it`,
        };
    if (answer.outcome === "unreachable") {
      setFulfillmentState(db, {
        grantId: grant.grantId,
        peerVaultId: row.peerVaultId,
        state: "remove_sent",
        updatedAt: input.now,
        detail: answer.detail,
      });
      steps.push({
        peerVaultId: row.peerVaultId,
        state: "remove_sent",
        detail: answer.detail,
      });
      continue;
    }
    setFulfillmentState(db, {
      grantId: grant.grantId,
      peerVaultId: row.peerVaultId,
      state: "removed",
      updatedAt: input.now,
      ...(answer.removed === 0 && answer.retained === 0
        ? { detail: "the audience vault no longer held a projection" }
        : {}),
    });
    steps.push({
      peerVaultId: row.peerVaultId,
      state: "removed",
      removed: answer.removed,
      retained: answer.retained,
    });
  }
  return { grantId: grant.grantId, shapeId, steps };
}
