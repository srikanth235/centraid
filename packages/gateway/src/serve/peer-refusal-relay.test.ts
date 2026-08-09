/*
 * Exit evidence for #726 P3 gap 3: a D9 'refuse' answered after an 'ask'
 * used to die at the audience — the origin's `share_edges` row stayed
 * `parked` forever, reading as a non-answer. Same "two gateways, one
 * process" harness `peer-remote-give.test.ts` uses (`peer-give.test-fixtures.ts`),
 * split into its own file because it exercises a different module
 * (`peer-refusal-relay.ts`) than the give/pull mechanics that file covers.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";

import { makeEdgeAnswerRouteHandler } from "../routes/edge-answer-routes.js";
import { reconcileRemoteEdge } from "../routes/edges-reconcile-remote.js";
import { readEdgeRow } from "../routes/edges-reconcile.js";
import { EnrollmentStore } from "./enrollment-store.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import {
  dialFrom,
  insertEdgeRow,
  link,
  makeSide,
  routeFrom,
  seedPhoto,
} from "./peer-give.test-fixtures.js";
import type { Side } from "./peer-give.test-fixtures.js";
import { setReceiveSetting } from "./peer-receive-settings.js";
import { drainPeerRefusals } from "./peer-refusal-relay.js";

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

describe("D9 refusal reaches the origin (#726 P3 gap 3)", () => {
  test("a 'refuse' after 'ask' reaches the origin — its edge lands `denied`, never stuck `parked`", async () => {
    const origin = makeSide("origin-f");
    const audience = makeSide("audience-f");
    await link(origin, audience);
    const linkId = audience.links.findPair(
      origin.vaultId,
      audience.vaultId
    )!.linkId;
    setReceiveSetting(audience.gatewayDb, linkId, audience.vaultId, "ask");

    const photo = seedPhoto(origin, "refused-after-ask");
    const row = insertEdgeRow(origin, {
      edgeId: "edge-refuse-reaches-origin",
      audienceVaultId: audience.vaultId,
      itemIds: [photo.assetId],
    });
    await reconcileRemoteEdge(
      origin.gatewayDb,
      row,
      origin.vault,
      routeFrom(origin, audience),
      dialFrom(origin, audience)
    );
    expect(readEdgeRow(origin.gatewayDb, row.edge_id)!.status).toBe("parked");

    const answer = await answerRefuse(audience, row.edge_id);
    expect(answer.status).toBe(200);
    expect(answer.body).toStrictEqual({
      edgeId: row.edge_id,
      decision: "refuse",
    });

    // Durable the instant the answer returns, before any delivery attempt.
    expect(
      audience.gatewayDb.db
        .prepare("SELECT * FROM peer_pending_refusals WHERE edge_id = ?")
        .get(row.edge_id)
    ).toBeDefined();
    // The origin has not heard yet.
    expect(readEdgeRow(origin.gatewayDb, row.edge_id)!.status).toBe("parked");

    // The background tick delivers it.
    const drained = await drainPeerRefusals({
      db: audience.gatewayDb,
      links: audience.links,
      dial: dialFrom(audience, origin),
    });
    expect(drained.acknowledged).toStrictEqual([row.edge_id]);
    expect(
      audience.gatewayDb.db
        .prepare("SELECT * FROM peer_pending_refusals WHERE edge_id = ?")
        .get(row.edge_id)
    ).toBeUndefined();
    const originRow = readEdgeRow(origin.gatewayDb, row.edge_id)!;
    expect(originRow.status).toBe("denied");
    expect(originRow.reason).toBe("recipient declined this share");
  });

  test("a 'refuse' answered while the origin is unreachable is never lost — it delivers on the next contact", async () => {
    const origin = makeSide("origin-g");
    const audience = makeSide("audience-g");
    await link(origin, audience);
    const linkId = audience.links.findPair(
      origin.vaultId,
      audience.vaultId
    )!.linkId;
    setReceiveSetting(audience.gatewayDb, linkId, audience.vaultId, "ask");

    const photo = seedPhoto(origin, "refused-unreachable");
    const row = insertEdgeRow(origin, {
      edgeId: "edge-refuse-unreachable",
      audienceVaultId: audience.vaultId,
      itemIds: [photo.assetId],
    });
    await reconcileRemoteEdge(
      origin.gatewayDb,
      row,
      origin.vault,
      routeFrom(origin, audience),
      dialFrom(origin, audience)
    );

    const answer = await answerRefuse(audience, row.edge_id);
    // The owner's answer succeeds immediately regardless of the origin's
    // reachability — nothing here ever dials out.
    expect(answer.status).toBe(200);

    const unreachableDial: PeerDial = {
      request: async () => {
        throw new Error("simulated: origin unreachable");
      },
      endpointTicketFor: (id) => `ticket-for-${id}`,
    };
    const firstAttempt = await drainPeerRefusals({
      db: audience.gatewayDb,
      links: audience.links,
      dial: unreachableDial,
    });
    expect(firstAttempt.pending).toStrictEqual([row.edge_id]);
    // Still durable, still parked at the origin — never lost, never applied
    // early.
    expect(
      audience.gatewayDb.db
        .prepare("SELECT * FROM peer_pending_refusals WHERE edge_id = ?")
        .get(row.edge_id)
    ).toBeDefined();
    expect(readEdgeRow(origin.gatewayDb, row.edge_id)!.status).toBe("parked");

    // The next contact succeeds.
    const secondAttempt = await drainPeerRefusals({
      db: audience.gatewayDb,
      links: audience.links,
      dial: dialFrom(audience, origin),
    });
    expect(secondAttempt.acknowledged).toStrictEqual([row.edge_id]);
    expect(readEdgeRow(origin.gatewayDb, row.edge_id)!.status).toBe("denied");
  });
});
