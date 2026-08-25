// The share-grant SCHEDULE and ORACLE for the Commons simulator (#839); the
// physical world lives in `commons-sim-grant-world.test-fixtures.ts`. Every
// verb calls the real product path. The four golden claims:
//
//   G1 REVOCATION SEVERS: once settled the audience holds no projection and
//      no delivery is possible; `remove_sent` is the not-yet.
//   G2 PARKED PAYLOADS SETTLE, NEVER UNPARK: a payload leaves the pool once.
//   G3 THE STATE MACHINE TAKES ONLY LEGAL EDGES — see `LEGAL_TRANSITIONS`.
//   G-view THE ORIGIN IS THE SOLE AUTHOR: a pass re-projects, never merges.
//
// Nothing here is pinned: every invariant simply fails on violation.

import {
  fulfillShareGrant,
  propagateShareGrantRevocation,
} from "../grant/fulfillment.js";
import type { ShareFulfillmentState } from "../grant/grant-store.js";
import {
  createShareGrant,
  readFulfillment,
  revokeShareGrant,
} from "../grant/grant-store.js";
import { readDurableParkedPayload } from "../replica/parked.js";
import type {
  GrantPlane,
  ShareSlot,
} from "./commons-sim-grant-world.test-fixtures.js";
import {
  PARKING_COMMAND,
  addAlbumPhoto,
  audienceTitles,
  bindSlotChannel,
  buildGrantPlane,
  freshConsentGrant,
  originTitles,
  projectedAlbumId,
  projectionRowCount,
  seatRefFor,
  tamperAudience,
} from "./commons-sim-grant-world.test-fixtures.js";
import type { Rng, Seat, World } from "./commons-sim-world.test-fixtures.js";
import {
  NOW,
  closeWorld,
  createWorld,
} from "./commons-sim-world.test-fixtures.js";

/** Fulfillment outweighs lifecycle verbs: mostly delivery under churn. */
export const GRANT_ACTION_WEIGHTS = {
  grant_create: 5,
  grant_fulfill: 16,
  grant_origin_edit: 8,
  grant_audience_tamper: 4,
  grant_channel_churn: 7,
  grant_revoke: 4,
  grant_propagate: 6,
  park_confirmable: 7,
  settle_parked: 7,
  revoke_consent_grant: 4,
} as const;

export type GrantActionName = keyof typeof GRANT_ACTION_WEIGHTS;

/**
 * Every legal edge, keyed by the state observed BEFORE an action; `none` is
 * "no row yet". `ensureFulfillment` never falls an existing row back to
 * `awaiting_channel`; one action can cross `syncing` to `delivered`;
 * propagation alone writes `remove_sent`/`removed`, which are terminal.
 */
const LEGAL_TRANSITIONS: Record<string, readonly ShareFulfillmentState[]> = {
  none: ["awaiting_channel", "syncing", "delivered"],
  awaiting_channel: ["awaiting_channel", "syncing", "delivered", "removed"],
  syncing: ["syncing", "delivered", "removed"],
  delivered: ["syncing", "delivered", "remove_sent", "removed"],
  remove_sent: ["remove_sent", "removed"],
  removed: ["removed"],
};

function plane(world: World): GrantPlane {
  if (!world.plane) throw new Error("the grant plane was never built");
  return world.plane;
}

function fail(world: World, message: string): void {
  world.failures.push(`#${world.step} ${message}`);
}

function refuses(
  world: World,
  label: string,
  needle: string,
  call: () => unknown
): void {
  try {
    call();
    fail(world, `${label}: expected a refusal naming "${needle}"`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(needle))
      fail(world, `${label}: refused with "${message}", wanted "${needle}"`);
  }
}

/** Checks the edge just taken is legal (G3), then moves the model onto it. */
function observe(world: World, slot: ShareSlot, label: string): void {
  if (slot.grantId === undefined) return;
  const next = readFulfillment(
    slot.origin.db.vault,
    slot.grantId,
    slot.peerVaultId
  )?.state;
  const before = slot.fulfillment ?? "none";
  if (next === undefined) {
    if (before !== "none")
      fail(world, `${slot.key} ${label}: fulfillment row ${before} vanished`);
    return;
  }
  if (!LEGAL_TRANSITIONS[before]?.includes(next))
    fail(world, `${slot.key} ${label}: illegal edge ${before} -> ${next}`);
  if (before === "delivered" && next === "syncing") {
    slot.reachLostAfterDelivery = true;
    world.stats["reach_lost_after_delivery"] =
      (world.stats["reach_lost_after_delivery"] ?? 0) + 1;
  }
  slot.fulfillment = next;
}

/** G-view: no stale caption, no surviving audience edit, ONE provenance row. */
function checkProjection(world: World, slot: ShareSlot, label: string): void {
  const held = audienceTitles(slot);
  const truth = originTitles(slot);
  if (held === undefined) {
    fail(world, `${slot.key} ${label}: delivered, yet the audience holds none`);
    return;
  }
  if (JSON.stringify(held) !== JSON.stringify(truth))
    fail(
      world,
      `${slot.key} ${label}: audience ${JSON.stringify(held)} != origin ${JSON.stringify(truth)}`
    );
  const rows = projectionRowCount(slot);
  if (rows !== 1)
    fail(world, `${slot.key} ${label}: ${rows} provenance rows, wanted 1`);
  if (JSON.stringify(truth) !== JSON.stringify(slot.album.titles))
    fail(
      world,
      `${slot.key} ${label}: the origin's own album drifted to ${JSON.stringify(truth)}`
    );
  // "Sole author" is empty unless a pass actually wiped a contesting edit.
  if (slot.tampered) {
    world.stats["grant_tamper_healed"] =
      (world.stats["grant_tamper_healed"] ?? 0) + 1;
    slot.tampered = false;
  }
}

/**
 * G1, with NO reach-lost carve-out (#846): `delivered_at` is durable, so an
 * unreachable pass cannot demote a `delivered` row and let propagation settle
 * `removed` while the peer keeps the copy.
 */
function checkSeverance(world: World, slot: ShareSlot, label: string): void {
  if (slot.fulfillment !== "removed") return;
  if (projectedAlbumId(slot) === undefined) return;
  fail(
    world,
    `${slot.key} ${label}: revocation settled 'removed' yet the audience still holds ${JSON.stringify(audienceTitles(slot))}`
  );
}

function createAction(world: World, rng: Rng): void {
  const slot = rng.pick(
    plane(world).slots.filter((entry) => entry.grantId === undefined)
  );
  if (!slot) return;
  const made = createShareGrant(slot.origin.db.vault, {
    audience: { kind: "party", id: slot.audiencePartyId },
    subjectType: "core.collection",
    subjectId: slot.album.albumId,
    capability: "view",
    grantedAt: NOW,
    grantedBy: slot.origin.partyId,
  });
  if (made.outcome !== "created")
    fail(world, `${slot.key} grant_create: outcome ${made.outcome}`);
  // A repeated share gesture is not an error and never mints a rival row.
  const again = createShareGrant(slot.origin.db.vault, {
    audience: { kind: "party", id: slot.audiencePartyId },
    subjectType: "core.collection",
    subjectId: slot.album.albumId,
    capability: "view",
    grantedAt: NOW,
    grantedBy: slot.origin.partyId,
  });
  if (again.outcome !== "exists" || again.grantId !== made.grantId)
    fail(world, `${slot.key} grant_create: re-share made ${again.outcome}`);
  slot.grantId = made.grantId;
  world.trace.push(`#${world.step} grant_create ${slot.key}`);
}

function fulfillAction(
  world: World,
  slot: ShareSlot,
  reachable: boolean
): void {
  if (slot.grantId === undefined) return;
  if (slot.revoked) {
    // G1: a revoked grant is never delivered again, at any reach.
    refuses(world, `${slot.key} grant_fulfill`, "is revoked", () =>
      fulfillShareGrant({
        origin: slot.origin.db,
        originVaultId: slot.origin.vaultId,
        grantId: slot.grantId as string,
        seatFor: seatRefFor(plane(world), reachable),
        now: NOW,
      })
    );
    return;
  }
  const result = fulfillShareGrant({
    origin: slot.origin.db,
    originVaultId: slot.origin.vaultId,
    grantId: slot.grantId,
    seatFor: seatRefFor(plane(world), reachable),
    now: NOW,
  });
  const step = result.steps[0];
  if (result.steps.length !== 1 || !step) {
    fail(world, `${slot.key} grant_fulfill: ${result.steps.length} steps`);
    return;
  }
  // Decision order: no channel parks, an uncarryable one is `syncing`.
  const reached = reachable ? "delivered" : "syncing";
  const wanted = slot.linked ? reached : "awaiting_channel";
  if (step.state !== wanted)
    fail(
      world,
      `${slot.key} grant_fulfill: state ${step.state}, wanted ${wanted} (linked=${slot.linked} reach=${reachable})`
    );
  observe(world, slot, "grant_fulfill");
  if (step.state === "delivered") {
    slot.everDelivered = true;
    checkProjection(world, slot, "grant_fulfill");
  }
  world.trace.push(
    `#${world.step} grant_fulfill ${slot.key} reach=${reachable} -> ${step.state}`
  );
}

function editAction(world: World, rng: Rng, slot: ShareSlot): void {
  const index = rng.int(slot.album.titles.length + 1);
  if (index >= slot.album.titles.length) {
    addAlbumPhoto(slot, `${slot.key}-p${slot.album.minted}`);
  } else {
    const title = `${slot.album.titles[index]}!${world.step}`;
    slot.origin.db.vault
      .prepare(
        `UPDATE core_content_item SET title = ?
          WHERE content_id IN (
            SELECT a.content_id FROM core_collection_entry e
              JOIN media_asset a ON a.asset_id = e.target_id
             WHERE e.collection_id = ? AND e.position = ?)`
      )
      .run(title, slot.album.albumId, index);
    slot.album.titles[index] = title;
  }
  world.trace.push(`#${world.step} grant_origin_edit ${slot.key}`);
}

function propagateAction(
  world: World,
  slot: ShareSlot,
  reachable: boolean
): void {
  if (slot.grantId === undefined) return;
  if (!slot.revoked) {
    // The engine refuses an undated revocation, so the halves cannot drift.
    refuses(world, `${slot.key} grant_propagate`, "still stands", () =>
      propagateShareGrantRevocation({
        origin: slot.origin.db,
        originVaultId: slot.origin.vaultId,
        grantId: slot.grantId as string,
        seatFor: seatRefFor(plane(world), reachable),
        now: NOW,
      })
    );
    return;
  }
  const removal = propagateShareGrantRevocation({
    origin: slot.origin.db,
    originVaultId: slot.origin.vaultId,
    grantId: slot.grantId,
    seatFor: seatRefFor(plane(world), reachable),
    now: NOW,
  });
  observe(world, slot, "grant_propagate");
  checkSeverance(world, slot, "grant_propagate");
  world.trace.push(
    `#${world.step} grant_propagate ${slot.key} reach=${reachable} -> ${removal.steps.map((entry) => entry.state).join(",")}`
  );
}

function parkAction(world: World, seat: Seat): void {
  const agent = plane(world).agents.get(seat.index);
  if (!agent) return;
  const outcome = seat.gateway.invoke(agent.credential, {
    command: PARKING_COMMAND,
    input: { name: `sim-friend-${seat.index}-${world.step}` },
    purpose: "dpv:ServiceProvision",
  });
  if (outcome.status !== "parked") {
    fail(world, `seat ${seat.index} park_confirmable: ${outcome.status}`);
    return;
  }
  if (!readDurableParkedPayload(seat.db, outcome.invocationId)) {
    fail(world, `seat ${seat.index} park_confirmable: no durable payload`);
    return;
  }
  plane(world).parked.push({
    seat,
    invocationId: outcome.invocationId,
    consentGrantId: agent.consentGrantId,
    settled: false,
  });
  world.trace.push(`#${world.step} park_confirmable seat=${seat.index}`);
}

function settleAction(world: World, rng: Rng, approve: boolean): void {
  const fact = rng.pick(plane(world).parked.filter((entry) => !entry.settled));
  if (!fact) return;
  const outcome = fact.seat.gateway.confirm(
    fact.seat.credential,
    fact.invocationId,
    approve
  );
  const wanted = approve ? "executed" : "denied";
  if (outcome.status !== wanted)
    fail(
      world,
      `seat ${fact.seat.index} settle_parked: ${outcome.status}, wanted ${wanted}`
    );
  fact.settled = true;
  fact.how = approve ? "approved" : "denied";
  checkParked(world, fact.seat.index);
  world.trace.push(
    `#${world.step} settle_parked seat=${fact.seat.index} approve=${approve} -> ${outcome.status}`
  );
}

/** A settlement, not an escape: those invocations are terminal. */
function consentRevokeAction(world: World, seat: Seat): void {
  const agent = plane(world).agents.get(seat.index);
  if (!agent) return;
  seat.gateway.revokeGrant(seat.credential, agent.consentGrantId);
  for (const fact of plane(world).parked)
    if (!fact.settled && fact.consentGrantId === agent.consentGrantId) {
      fact.settled = true;
      fact.how = "consent-revoked";
    }
  agent.consentGrantId = freshConsentGrant(seat, agent.agentPartyId);
  checkParked(world, seat.index);
  world.trace.push(`#${world.step} revoke_consent_grant seat=${seat.index}`);
}

/** G2: settled payloads stay gone; a reappearance is an UNPARK, which no verb offers. */
function checkParked(world: World, seatIndex: number): void {
  for (const fact of plane(world).parked) {
    if (fact.seat.index !== seatIndex) continue;
    const held = readDurableParkedPayload(fact.seat.db, fact.invocationId);
    if (fact.settled && held)
      fail(
        world,
        `seat ${seatIndex} parked ${fact.invocationId} settled ${fact.how} yet is parked again`
      );
    if (!fact.settled && !held)
      fail(
        world,
        `seat ${seatIndex} parked ${fact.invocationId} left the pool unsettled`
      );
  }
}

export function runGrantAction(
  world: World,
  rng: Rng,
  name: GrantActionName
): void {
  const slots = plane(world).slots;
  const live = slots.filter((slot) => slot.grantId !== undefined);
  const seat = rng.pick(plane(world).seats);
  // One pass in four is out of reach, or those legs never fire.
  const reachable = rng.int(4) !== 0;
  switch (name) {
    case "grant_create":
      createAction(world, rng);
      break;
    case "grant_fulfill": {
      const slot = rng.pick(live);
      if (slot) fulfillAction(world, slot, reachable);
      break;
    }
    case "grant_origin_edit": {
      const slot = rng.pick(slots);
      if (slot) editAction(world, rng, slot);
      break;
    }
    case "grant_audience_tamper": {
      const slot = rng.pick(live);
      if (slot && tamperAudience(slot, `tampered-${world.step}`)) {
        slot.tampered = true;
        world.trace.push(`#${world.step} grant_audience_tamper ${slot.key}`);
      }
      break;
    }
    case "grant_channel_churn": {
      const slot = rng.pick(slots);
      if (slot) {
        bindSlotChannel(slot, !slot.linked);
        world.trace.push(
          `#${world.step} grant_channel_churn ${slot.key} -> linked=${slot.linked}`
        );
      }
      break;
    }
    case "grant_revoke": {
      const standing = live.filter((entry) => !entry.revoked);
      // Never the LAST standing grant: nothing standing passes vacuously.
      const slot = standing.length > 1 ? rng.pick(standing) : undefined;
      if (slot) revokeAction(world, slot);
      break;
    }
    case "grant_propagate": {
      const slot = rng.pick(live);
      if (slot) propagateAction(world, slot, reachable);
      break;
    }
    case "park_confirmable":
      if (seat) parkAction(world, seat);
      break;
    case "settle_parked":
      settleAction(world, rng, reachable);
      break;
    case "revoke_consent_grant":
      if (seat) consentRevokeAction(world, seat);
      break;
  }
}

function revokeAction(world: World, slot: ShareSlot): void {
  const grantId = slot.grantId as string;
  const first = revokeShareGrant(slot.origin.db.vault, {
    grantId,
    revokedAt: NOW,
  });
  if (first.outcome !== "revoked")
    fail(world, `${slot.key} grant_revoke: outcome ${first.outcome}`);
  const again = revokeShareGrant(slot.origin.db.vault, {
    grantId,
    revokedAt: NOW,
  });
  if (again.outcome !== "already-revoked")
    fail(world, `${slot.key} grant_revoke: replay gave ${again.outcome}`);
  slot.revoked = true;
  world.trace.push(`#${world.step} grant_revoke ${slot.key}`);
}

/** Anything still divergent after this rest is a defect, not a race. */
export function quiesceGrantPlane(world: World): void {
  for (const slot of plane(world).slots) {
    if (!slot.linked) bindSlotChannel(slot, true);
    if (slot.grantId === undefined) continue;
    if (slot.revoked) propagateAction(world, slot, true);
    else fulfillAction(world, slot, true);
  }
}

export function checkGrantInvariants(world: World): void {
  const grantPlane = plane(world);
  let delivered = 0;
  let severed = 0;
  for (const slot of grantPlane.slots) {
    if (slot.grantId === undefined) continue;
    if (slot.revoked) {
      checkSeverance(world, slot, "quiesced");
      // G1's second half: no future pass revives it.
      refuses(world, `${slot.key} quiesced`, "is revoked", () =>
        fulfillShareGrant({
          origin: slot.origin.db,
          originVaultId: slot.origin.vaultId,
          grantId: slot.grantId as string,
          seatFor: seatRefFor(grantPlane, true),
          now: NOW,
        })
      );
      // Only a SETTLED revocation is proof; an unfulfilled one severed nothing.
      if (slot.fulfillment === "removed") severed += 1;
      continue;
    }
    checkProjection(world, slot, "quiesced");
    if (slot.everDelivered) delivered += 1;
  }
  for (const seat of grantPlane.seats) checkParked(world, seat.index);
  const settled = grantPlane.parked.filter((fact) => fact.settled).length;
  // A plane that delivered, severed and settled nothing passes vacuously.
  if (delivered === 0 || severed === 0 || settled === 0)
    world.failures.push(
      `the grant plane proved nothing: ${delivered} standing, ${severed} severed, ${settled} settled payloads`
    );
}

export function buildPlaneFor(world: World, albumsPerPair: number): void {
  world.plane = buildGrantPlane(world, albumsPerPair);
}

export interface SeveranceProbe {
  audienceTitles: string[];
  state: ShareFulfillmentState | undefined;
}

/** The minimal deterministic walk to defect D1, pinned by `commons-sim.test.ts`. */
export function runRevocationSeveranceProbe(): SeveranceProbe {
  const world = createWorld({ seed: 839_000, actions: 0, seats: 2, grants: 2 });
  try {
    buildPlaneFor(world, 1);
    const slot = plane(world).slots[0] as ShareSlot;
    createAction(world, { int: () => 0, pick: (items) => items[0] });
    fulfillAction(world, slot, true);
    fulfillAction(world, slot, false);
    revokeAction(world, slot);
    propagateAction(world, slot, true);
    return {
      audienceTitles: audienceTitles(slot) ?? [],
      state: slot.fulfillment,
    };
  } finally {
    closeWorld(world);
  }
}
