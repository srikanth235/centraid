/*
 * Exit evidence for #726 P3 gap 3, re-pinned on the #750 outbox: a D9
 * 'refuse' answered after an 'ask' used to die at the audience — the origin's
 * `share_edges` row stayed `parked` forever, reading as a non-answer.
 *
 * Succeeds `peer-refusal-relay.test.ts`, which pinned the same semantics
 * against the deleted `peer_pending_refusals` table and its private drainer.
 * Every guarantee that suite held is asserted here against the ONE share
 * outbox instead: the answer is durable BEFORE any network attempt, an
 * offline origin never loses it, and the retry is the same obligation rather
 * than a new one.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";

import { makeEdgeAnswerRouteHandler } from "../routes/edge-answer-routes.js";
import { EnrollmentStore } from "./enrollment-store.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import {
  deliverEdge,
  dialFrom,
  drainEdgeEffects,
  insertEdgeRow,
  link,
  makeSide,
  seedPhoto,
} from "./peer-give.test-fixtures.js";
import type { Side } from "./peer-give.test-fixtures.js";
import { setReceiveSetting } from "./peer-receive-settings.js";
import { readEdgeRow } from "./share-edge-row.js";
import { findQueuedEffect } from "./share-effects.js";

async function answerRefuse(
  audience: Side,
  edgeId: string
): Promise<{ status: number; body: unknown }> {
  const handler = makeEdgeAnswerRouteHandler({
    gatewayDatabase: audience.gatewayDb,
    enrollments: EnrollmentStore.open(audience.gatewayDb),
    links: audience.links,
    vaultFor: (vaultId) =>
      vaultId === audience.vaultId ? audience.vault : undefined,
    // No peerDial wired here at all — the refuse branch touches no network,
    // and its 200 must not depend on one existing.
  });
  const req = Readable.from([
    Buffer.from(JSON.stringify({ decision: "refuse" })),
  ]) as IncomingMessage;
  req.method = "POST";
  req.url = `/centraid/_gateway/edges/${edgeId}/answer`;
  req.headers = { [AUTHED_DEVICE_HEADER]: audience.deviceId };
  let status = 0;
  let body = "";
  const res = {
    setHeader: () => undefined,
    end(value?: string | Buffer) {
      if (value) body += value.toString();
    },
    get statusCode() {
      return status;
    },
    set statusCode(value: number) {
      status = value;
    },
  } as unknown as ServerResponse;
  await handler(req, res);
  return { status, body: body ? JSON.parse(body) : undefined };
}

async function askedEdge(
  name: string,
  edgeId: string
): Promise<{ origin: Side; audience: Side }> {
  const origin = makeSide(`origin-${name}`);
  const audience = makeSide(`audience-${name}`);
  await link(origin, audience);
  const linkId = audience.links.findPair(
    origin.vaultId,
    audience.vaultId
  )!.linkId;
  setReceiveSetting(audience.gatewayDb, linkId, audience.vaultId, "ask");
  const photo = seedPhoto(origin, name);
  const row = insertEdgeRow(origin, {
    edgeId,
    audienceVaultId: audience.vaultId,
    itemIds: [photo.assetId],
  });
  await deliverEdge(origin, row, dialFrom(origin, audience));
  return { origin, audience };
}

describe("D9 refusal reaches the origin (#726 P3 gap 3, #750 outbox)", () => {
  test("a 'refuse' after 'ask' reaches the origin — its edge lands `denied`, never stuck `parked`", async () => {
    const edgeId = "edge-refuse-reaches-origin";
    const { origin, audience } = await askedEdge("f", edgeId);
    expect(readEdgeRow(origin.gatewayDb, edgeId)!.status).toBe("parked");

    const answer = await answerRefuse(audience, edgeId);
    expect(answer.status).toBe(200);
    expect(answer.body).toStrictEqual({ edgeId, decision: "refuse" });

    // Durable the instant the answer returns, before any delivery attempt —
    // and the ask it answered is closed in that same transaction.
    expect(
      findQueuedEffect(audience.gatewayDb, "deliver-refusal", edgeId)
    ).toBeDefined();
    expect(
      findQueuedEffect(audience.gatewayDb, "await-answer", edgeId)
    ).toBeUndefined();
    // The origin has not heard yet.
    expect(readEdgeRow(origin.gatewayDb, edgeId)!.status).toBe("parked");

    // The background tick delivers it.
    const drained = await drainEdgeEffects(
      audience,
      dialFrom(audience, origin)
    );
    expect(drained.done).toHaveLength(1);
    expect(
      findQueuedEffect(audience.gatewayDb, "deliver-refusal", edgeId)
    ).toBeUndefined();
    const originRow = readEdgeRow(origin.gatewayDb, edgeId)!;
    expect(originRow.status).toBe("denied");
    expect(originRow.reason).toBe("recipient declined this share");
  });

  test("a 'refuse' answered while the origin is unreachable is never lost — it delivers on the next contact", async () => {
    const edgeId = "edge-refuse-unreachable";
    const { origin, audience } = await askedEdge("g", edgeId);

    const answer = await answerRefuse(audience, edgeId);
    // The owner's answer succeeds immediately regardless of the origin's
    // reachability — nothing here ever dials out.
    expect(answer.status).toBe(200);

    const unreachableDial: PeerDial = {
      request: async () => {
        throw new Error("simulated: origin unreachable");
      },
      endpointTicketFor: (id) => `ticket-for-${id}`,
    };
    const firstAttempt = await drainEdgeEffects(audience, unreachableDial);
    expect(firstAttempt.retried).toHaveLength(1);
    // Still durable, still parked at the origin — never lost, never applied
    // early.
    expect(
      findQueuedEffect(audience.gatewayDb, "deliver-refusal", edgeId)
    ).toBeDefined();
    expect(readEdgeRow(origin.gatewayDb, edgeId)!.status).toBe("parked");

    // A failed attempt backs off rather than spinning: the very next tick
    // finds nothing due yet, and the one after the backoff window delivers.
    const immediate = await drainEdgeEffects(
      audience,
      dialFrom(audience, origin)
    );
    expect(immediate.done).toHaveLength(0);
    expect(readEdgeRow(origin.gatewayDb, edgeId)!.status).toBe("parked");

    const later = await drainEdgeEffects(audience, dialFrom(audience, origin), {
      now: Date.now() + 60_000,
    });
    expect(later.done).toHaveLength(1);
    expect(readEdgeRow(origin.gatewayDb, edgeId)!.status).toBe("denied");
  });
});
