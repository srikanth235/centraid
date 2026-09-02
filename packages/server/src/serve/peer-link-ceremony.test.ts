/*
 * The ceremony end to end (#726 P3 decision 3), both gateways in one process:
 * what the two halves cannot prove alone is that the link is MUTUAL (each side
 * holds the other's vault id, key, route and labels) and DIRECTION-FREE
 * (nothing about the resulting rows records who showed).
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";
import { PEER_ENDPOINT_HEADER, PEER_PROOF_HEADER } from "@centraid/tunnel";
import { signWithVaultIdentity, vaultIdentityPublicKey } from "@centraid/vault";

import { makePeerPlaneHandler } from "../routes/peer-plane.js";
import { GatewayDatabase } from "./gateway-db.js";
import {
  encodeLinkTicket,
  parseLinkTicket,
  pushRouteAssertion,
  redeemLinkTicket,
} from "./peer-link-client.js";
import type { PeerRequest } from "./peer-link-client.js";
import { VaultLinksStore } from "./vault-links-store.js";

interface Side {
  vaultId: string;
  partyId: string;
  seed: Buffer;
  publicKey: string;
  endpointId: string;
  label: string;
  links: VaultLinksStore;
  proof: string;
}

function makeSide(name: string): Side {
  const seed = crypto.randomBytes(32);
  return {
    vaultId: `vlt_${name}`,
    partyId: `party_${name}`,
    seed,
    publicKey: vaultIdentityPublicKey(seed).toString("base64"),
    endpointId: `ep-${name}`,
    label: name,
    links: VaultLinksStore.open(
      GatewayDatabase.open(tempDirSync(`centraid-${name}-`))
    ),
    proof: crypto.randomBytes(32).toString("hex"),
  };
}

/** A peer request that lands on `side`'s handler, as the relay would deliver it. */
function transportTo(side: Side, callerEndpointId: string): PeerRequest {
  const handler = makePeerPlaneHandler({
    links: side.links,
    peerProof: side.proof,
    vaultPublicKey: (vaultId) =>
      vaultId === side.vaultId ? side.publicKey : undefined,
    ownerPartyFor: (vaultId) =>
      vaultId === side.vaultId ? side.partyId : undefined,
    localRoute: () => ({ endpointId: side.endpointId, relayHints: [] }),
    localLabel: () => side.label,
  });
  return async (input) => {
    let status = 0;
    let body = "";
    const req = Readable.from([
      Buffer.from(JSON.stringify(input.body ?? {})),
    ]) as IncomingMessage;
    req.method = input.method;
    req.url = input.target;
    req.headers = {
      [PEER_ENDPOINT_HEADER]: callerEndpointId,
      [PEER_PROOF_HEADER]: side.proof,
    };
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
    return { status, json: body ? (JSON.parse(body) as unknown) : undefined };
  };
}

function showTicket(side: Side) {
  const ticket = side.links.tickets.mint(side.vaultId, side.publicKey);
  return encodeLinkTicket({
    v: 1,
    kind: "centraid-link",
    vaultId: side.vaultId,
    vaultPublicKey: side.publicKey,
    endpointTicket: `ticket-for-${side.endpointId}`,
    ticketId: ticket.ticketId,
    secret: ticket.secret,
  });
}

async function link(shower: Side, scanner: Side) {
  const payload = parseLinkTicket(showTicket(shower))!;
  return redeemLinkTicket({
    ticket: payload,
    links: scanner.links,
    request: transportTo(shower, scanner.endpointId),
    localVault: { vaultId: scanner.vaultId, publicKey: scanner.publicKey },
    localOwnerPartyId: scanner.partyId,
    localRoute: { endpointId: scanner.endpointId, relayHints: [] },
    localLabel: scanner.label,
  });
}

describe("link ceremony end to end", () => {
  it("leaves both sides holding the other, whichever one showed", async () => {
    const alice = makeSide("alice");
    const bob = makeSide("bob");
    const result = await link(alice, bob);
    expect(result.state).toBe("linked");

    const onBob = bob.links.peerForVault(alice.vaultId);
    expect(onBob).toMatchObject({
      localVaultId: bob.vaultId,
      peerVaultId: alice.vaultId,
      peerPublicKey: alice.publicKey,
      localPartyId: bob.partyId,
      peerPartyId: alice.partyId,
      route: { endpointId: alice.endpointId },
      peerLabel: "alice",
      myLabel: "bob",
    });
    const onAlice = alice.links.peerForVault(bob.vaultId);
    expect(onAlice).toMatchObject({
      localVaultId: alice.vaultId,
      peerVaultId: bob.vaultId,
      peerPublicKey: bob.publicKey,
      localPartyId: alice.partyId,
      peerPartyId: bob.partyId,
      route: { endpointId: bob.endpointId },
      peerLabel: "bob",
      myLabel: "alice",
    });
    expect(Object.keys(onBob ?? {})).toStrictEqual(Object.keys(onAlice ?? {}));
  });

  it("is single-use: the same ticket cannot link a second scanner", async () => {
    const alice = makeSide("alice");
    const bob = makeSide("bob");
    const mallory = makeSide("mallory");
    const payload = parseLinkTicket(showTicket(alice))!;
    const common = {
      ticket: payload,
      localRoute: { endpointId: "", relayHints: [] },
    };
    const first = await redeemLinkTicket({
      ...common,
      links: bob.links,
      request: transportTo(alice, bob.endpointId),
      localVault: { vaultId: bob.vaultId, publicKey: bob.publicKey },
      localRoute: { endpointId: bob.endpointId, relayHints: [] },
      localLabel: bob.label,
    });
    expect(first.state).toBe("linked");
    const second = await redeemLinkTicket({
      ...common,
      links: mallory.links,
      request: transportTo(alice, mallory.endpointId),
      localVault: { vaultId: mallory.vaultId, publicKey: mallory.publicKey },
      localRoute: { endpointId: mallory.endpointId, relayHints: [] },
      localLabel: mallory.label,
    });
    expect(second).toStrictEqual({ state: "not_found" });
    expect(alice.links.list()).toHaveLength(1);
    expect(mallory.links.list()).toHaveLength(0);
  });

  it("refuses an answer that contradicts the ticket it came from", async () => {
    const alice = makeSide("alice");
    const bob = makeSide("bob");
    const payload = parseLinkTicket(showTicket(alice))!;
    const result = await redeemLinkTicket({
      // The advertised key is not the one the peer answers with — somebody rewrote one of the two.
      ticket: { ...payload, vaultPublicKey: bob.publicKey },
      links: bob.links,
      request: transportTo(alice, bob.endpointId),
      localVault: { vaultId: bob.vaultId, publicKey: bob.publicKey },
      localRoute: { endpointId: bob.endpointId, relayHints: [] },
      localLabel: bob.label,
    });
    expect(result.state).toBe("bad_request");
    expect(bob.links.list()).toHaveLength(0);
  });

  it("reports an unreachable peer as a state, leaving nothing written", async () => {
    const alice = makeSide("alice");
    const bob = makeSide("bob");
    const payload = parseLinkTicket(showTicket(alice))!;
    const result = await redeemLinkTicket({
      ticket: payload,
      links: bob.links,
      request: () => Promise.reject(new Error("no route to host")),
      localVault: { vaultId: bob.vaultId, publicKey: bob.publicKey },
      localRoute: { endpointId: bob.endpointId, relayHints: [] },
      localLabel: bob.label,
    });
    expect(result).toStrictEqual({
      state: "unreachable",
      detail: "no route to host",
    });
    expect(bob.links.list()).toHaveLength(0);
  });

  it.each(["", "{}", '{"v":2,"kind":"centraid-link"}', '{"v":1}', "not json"])(
    "parses %s into nothing",
    (raw) => {
      expect(parseLinkTicket(raw)).toBeUndefined();
    }
  );
});

describe("route re-assertion end to end", () => {
  it("re-finds every peer after a keypair rotation, without a new ceremony", async () => {
    const alice = makeSide("alice");
    const bob = makeSide("bob");
    await link(alice, bob);

    const rotated = "ep-alice-rotated";
    const outcomes = await pushRouteAssertion({
      links: alice.links,
      request: transportTo(bob, rotated),
      signAsVault: (vaultId, bytes) =>
        vaultId === alice.vaultId
          ? signWithVaultIdentity(alice.seed, bytes)
          : undefined,
      route: {
        vaultId: alice.vaultId,
        endpointId: rotated,
        relayHints: ["https://relay.example"],
      },
      now: () => Date.now() + 1000,
      endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
    });
    expect(outcomes).toStrictEqual([
      { peerVaultId: bob.vaultId, state: "accepted" },
    ]);
    expect(bob.links.peerForEndpoint(rotated)?.peerVaultId).toBe(alice.vaultId);
    expect(bob.links.linkForEndpoint(alice.endpointId)).toBeUndefined();
  });

  it("refuses an assertion signed with the wrong vault key", async () => {
    const alice = makeSide("alice");
    const bob = makeSide("bob");
    await link(alice, bob);

    const impostorSeed = crypto.randomBytes(32);
    const outcomes = await pushRouteAssertion({
      links: alice.links,
      request: transportTo(bob, "ep-impostor"),
      signAsVault: (_vaultId, bytes) =>
        signWithVaultIdentity(impostorSeed, bytes),
      route: {
        vaultId: alice.vaultId,
        endpointId: "ep-impostor",
        relayHints: [],
      },
      now: () => Date.now() + 1000,
      endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
    });
    expect(outcomes).toStrictEqual([
      { peerVaultId: bob.vaultId, state: "refused" },
    ]);
    expect(bob.links.linkForEndpoint(alice.endpointId)).toBeTruthy();
  });

  it("records an offline peer as offline rather than failing the push", async () => {
    const alice = makeSide("alice");
    const bob = makeSide("bob");
    await link(alice, bob);
    const outcomes = await pushRouteAssertion({
      links: alice.links,
      request: () => Promise.reject(new Error("offline")),
      signAsVault: (_vaultId, bytes) =>
        signWithVaultIdentity(alice.seed, bytes),
      route: { vaultId: alice.vaultId, endpointId: "ep-x", relayHints: [] },
      endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
    });
    expect(outcomes).toStrictEqual([
      { peerVaultId: bob.vaultId, state: "offline" },
    ]);
  });
});
