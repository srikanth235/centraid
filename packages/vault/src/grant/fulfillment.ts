/*
 * START, STOP, REPORT (#929). A grant is kept true by a SUBSCRIPTION, not by
 * the origin reaching into an audience vault: this module decides who should
 * hold the shape and hands frames to a transport. The transport is the only
 * thing that knows whether the audience is co-hosted (loopback) or on another
 * gateway (the peer replica route), which is what makes one delivery path
 * serve both — the reach that confined cross-gateway sharing to a second rail.
 *
 * Origin-authoritative throughout: the audience never authors over a projected
 * row, and revocation settles `removed` only on the seat's acknowledgement.
 */

import { sha256Hex } from "../ids.js";
import type { ShareVaultRef } from "../share/placement.js";
import type { ShareShapeFrame } from "../share/subscription-frame.js";
import { composeShareShape } from "../share/subscription-frame.js";
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
      outcome: "delivered";
      /** What the ingest had to write — the work-counter reading (#927). */
      apply: "bootstrap" | "reproject" | "fields";
      fieldUpdates: number;
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
  deliver: (frame: ShareShapeFrame) => ShareDeliveryOutcome;
  remove: (input: {
    shapeId: string;
    audienceVaultId: string;
  }) => ShareRemovalOutcome;
}

export interface ShareSubscriptionStep {
  partyId: string;
  state: ShareFulfillmentState;
  peerVaultId?: string;
  route?: ShareTransportRoute;
  detail?: string;
  apply?: "bootstrap" | "reproject" | "fields";
  fieldUpdates?: number;
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

/**
 * Per-grant × peer memory of WHAT was last composed. Rebuildable, so it lives
 * in host memory: a restart re-composes once and converges. Its only job is to
 * stop an unchanged shape reaching a transport at all.
 */
export interface GrantProjectionMemory {
  read: (grantId: string, peerVaultId: string) => string | undefined;
  write: (grantId: string, peerVaultId: string, digest: string) => void;
  forget: (grantId: string) => void;
}

/** The default: one Map per host, cleared with the process. */
export function createGrantProjectionMemory(): GrantProjectionMemory {
  const digests = new Map<string, string>();
  const key = (grantId: string, peerVaultId: string): string =>
    `${grantId} ${peerVaultId}`;
  return {
    read: (grantId, peerVaultId) => digests.get(key(grantId, peerVaultId)),
    write: (grantId, peerVaultId, digest) => {
      digests.set(key(grantId, peerVaultId), digest);
    },
    forget: (grantId) => {
      const stale = [...digests.keys()].filter((existing) =>
        existing.startsWith(`${grantId} `)
      );
      for (const entry of stale) digests.delete(entry);
    },
  };
}

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
  /** Omitted: every pass composes. */
  memory?: GrantProjectionMemory;
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

function frameFor(
  input: StartShareSubscriptionInput,
  grant: ShareGrantRecord,
  audienceVaultId: string
): ShareShapeFrame {
  return composeShareShape({
    origin: input.origin,
    originVaultId: input.originVaultId,
    audienceVaultId,
    shapeId: shareGrantShapeId(grant.grantId),
    grantId: grant.grantId,
    subjectType: grant.subjectType,
    subjectId: grant.subjectId,
    maxSizeBytes: grant.maxSizeBytes,
  });
}

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
  // COMPOSED ONCE, for every audience of this grant. The ceiling is judged
  // here, so an over-ceiling grant leaves no fulfillment row and dials no
  // transport; and the only thing the audience contributes to a frame is the
  // vault id it is addressed to, so re-stamping beats re-reading the closure —
  // one composition per pass rather than one per audience plus this one, and
  // every audience of a grant provably receives the same shape.
  const shape = frameFor(input, grant, "");
  const digest = sha256Hex(JSON.stringify(shape.closure));
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
    // DIFF FIRST. An unchanged shape over a peer already holding it composes no
    // frame and dials no transport. Consult `delivered_at`, never the
    // rebuildable digest alone.
    const standing = readFulfillment(db, grant.grantId, peerVaultId);
    if (
      standing?.state === "delivered" &&
      standing.deliveredAt !== null &&
      input.memory?.read(grant.grantId, peerVaultId) === digest
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
    const delivery = transport.deliver({
      ...shape,
      audienceVaultId: peerVaultId,
    });
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
    input.memory?.write(grant.grantId, peerVaultId, digest);
    steps.push({
      partyId,
      state: "delivered",
      peerVaultId,
      route: transport.route,
      apply: delivery.apply,
      fieldUpdates: delivery.fieldUpdates,
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
  /** Forgotten here, so a re-grant re-composes rather than trust a digest. */
  memory?: GrantProjectionMemory;
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
  input.memory?.forget(input.grantId);
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
      ? transport.remove({ shapeId, audienceVaultId: row.peerVaultId })
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
