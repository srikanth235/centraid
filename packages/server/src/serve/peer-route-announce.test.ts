/*
 * The production route-assertion wiring end to end (issue #750 invariant 3),
 * over the same in-process transport the ceremony tests use: a gateway whose
 * EndpointId rotated announces once, and every peer re-discovers it WITHOUT a
 * new link ceremony. Also proves the retry contract (an unheard peer keeps
 * the announcement armed) and the receiving-side invariant (one assertion
 * re-routes every co-hosted link at once, #750 invariants 1–2).
 */

import { describe, expect, test } from "vitest";

import type { PeerDial } from "./peer-edge-give-client.js";
import {
  link,
  makeCoHostedSides,
  makeSide,
  transportTo,
  transportToHost,
} from "./peer-give.test-fixtures.js";
import type { Side } from "./peer-give.test-fixtures.js";
import {
  announceLocalRoutes,
  LAST_ASSERTED_ENDPOINT_META_KEY,
} from "./peer-route-announce.js";

const silentLog = { info: () => undefined, warn: () => undefined };

function lastAssertedEndpoint(side: Side): string | undefined {
  const row = side.gatewayDb.db
    .prepare("SELECT value FROM gateway_meta WHERE key = ?")
    .get(LAST_ASSERTED_ENDPOINT_META_KEY) as { value: string } | undefined;
  return row?.value;
}

describe("route announcement (#750 invariant 3)", () => {
  test("a rotated endpoint is re-discovered by the peer without a new ceremony", async () => {
    const alice = makeSide("announce-alice");
    const bob = makeSide("announce-bob");
    await link(alice, bob);
    expect(bob.links.peerForVault(alice.vaultId)?.route.endpointId).toBe(
      alice.endpointId
    );

    const rotated = "ep-announce-alice-rotated";
    let dials = 0;
    const request = transportTo(bob, rotated);
    const dial: PeerDial = {
      request: (input) => {
        dials += 1;
        return request(input);
      },
      endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
    };
    const deps = {
      links: alice.links,
      dial,
      signAsVault: alice.signAsVault,
      localVaultIds: () => [alice.vaultId],
      route: () => ({
        endpointId: rotated,
        relayHints: ["https://relay.example"],
      }),
      log: silentLog,
      now: () => Date.now() + 60_000,
    };
    await expect(announceLocalRoutes(deps)).resolves.toBe("asserted");

    // Bob re-discovered the moved gateway — same link, new route.
    const onBob = bob.links.peerForVault(alice.vaultId);
    expect(onBob?.route.endpointId).toBe(rotated);
    expect(onBob?.route.relayHints).toStrictEqual(["https://relay.example"]);
    expect(onBob?.peerPublicKey).toBe(alice.publicKey);
    expect(bob.links.list()).toHaveLength(1);

    // The delivered endpoint is pinned, so an unchanged endpoint costs no
    // dial on the next start/tick.
    expect(lastAssertedEndpoint(alice)).toBe(rotated);
    const dialsAfterFirst = dials;
    await expect(announceLocalRoutes(deps)).resolves.toBe("idle");
    expect(dials).toBe(dialsAfterFirst);
  });

  test("an unheard peer keeps the announcement armed for the next start/tick", async () => {
    const alice = makeSide("announce-retry-alice");
    const bob = makeSide("announce-retry-bob");
    await link(alice, bob);

    const rotated = "ep-announce-retry-rotated";
    const warnings: string[] = [];
    const offline: PeerDial = {
      request: () => Promise.reject(new Error("no route to host")),
      endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
    };
    const base = {
      links: alice.links,
      signAsVault: alice.signAsVault,
      localVaultIds: () => [alice.vaultId],
      route: () => ({ endpointId: rotated, relayHints: [] }),
      now: () => Date.now() + 60_000,
    };
    await expect(
      announceLocalRoutes({
        ...base,
        dial: offline,
        log: { info: () => undefined, warn: (m) => warnings.push(m) },
      })
    ).resolves.toBe("partial");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/offline/u);
    // No pin: the endpoint change is still owed to the peer.
    expect(lastAssertedEndpoint(alice)).toBeUndefined();
    expect(bob.links.peerForVault(alice.vaultId)?.route.endpointId).toBe(
      alice.endpointId
    );

    // The retry (next start or sweep tick) delivers and pins.
    await expect(
      announceLocalRoutes({
        ...base,
        dial: {
          request: transportTo(bob, rotated),
          endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
        },
        log: silentLog,
      })
    ).resolves.toBe("asserted");
    expect(bob.links.peerForVault(alice.vaultId)?.route.endpointId).toBe(
      rotated
    );
    expect(lastAssertedEndpoint(alice)).toBe(rotated);
  });

  test("two co-hosted links to one peer vault both resolve the new route after ONE announcement", async () => {
    // The receiving gateway hosts TWO local vaults linked to the SAME remote
    // vault (the household shape) — its `vault_routes` row for that vault is
    // singular by construction (#750 invariants 1–2), so the remote's
    // announcement lands once and every link resolves through it.
    const [x, y] = makeCoHostedSides(
      "announce-host",
      "announce-x",
      "announce-y"
    );
    const remote = makeSide("announce-remote");
    await link(x, remote);
    await link(y, remote);

    const rotated = "ep-announce-remote-rotated";
    await expect(
      announceLocalRoutes({
        links: remote.links,
        dial: {
          request: transportToHost([x, y], rotated),
          endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
        },
        signAsVault: remote.signAsVault,
        localVaultIds: () => [remote.vaultId],
        route: () => ({ endpointId: rotated, relayHints: [] }),
        log: silentLog,
        now: () => Date.now() + 60_000,
      })
    ).resolves.toBe("asserted");

    for (const local of [x, y]) {
      const view = local.links.peerForVault(remote.vaultId, local.vaultId);
      expect(view?.route.endpointId).toBe(rotated);
      expect(view?.peerPublicKey).toBe(remote.publicKey);
    }
    // Still exactly one route row on the host — the invariant, structurally.
    const routeRows = x.gatewayDb.db
      .prepare("SELECT count(*) AS n FROM vault_routes WHERE vault_id = ?")
      .get(remote.vaultId) as { n: number };
    expect(routeRows.n).toBe(1);
  });
});
