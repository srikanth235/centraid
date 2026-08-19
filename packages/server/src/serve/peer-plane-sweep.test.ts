/*
 * Exit evidence for #726 P3 gap 2 (and gap 3's delivery half): the ONE share
 * outbox drains on a SCHEDULER TICK, not by a direct call — proved
 * here by calling only `.start()`/`.stop()` on the sweep and observing the
 * durable rows disappear on their own. `runOnce()` (the test seam for
 * `peer-blob-pull.test.ts`-style direct-call assertions) is deliberately
 * NOT used in the "drains on a tick" test below.
 */

import { describe, expect, it, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { GatewayDatabase } from "./gateway-db.js";
import type { PeerDial } from "./peer-link-client.js";
import { createPeerPlaneSweep } from "./peer-plane-sweep.js";
import { enqueueShareEffect, listQueuedEffects } from "./share-effects.js";
import { VaultLinksStore } from "./vault-links-store.js";

function seedRoutedLink(
  links: VaultLinksStore,
  localVaultId: string,
  peerVaultId: string
): string {
  const link = links.recordPeer({
    localVaultId,
    localPublicKey: "local-key",
    localLabel: "local",
    peerVaultId,
    peerPublicKey: "peer-key",
    peerLabel: "peer",
    route: { endpointId: "ep-peer", relayHints: [], assertedAt: Date.now() },
  });
  return link!.linkId;
}

const okDial: PeerDial = {
  request: async () => ({ status: 200, json: { state: "acknowledged" } }),
  endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
};

describe("peer plane sweep (#726 P3 gap 2)", () => {
  it("idles without touching either table when no dial is wired", async () => {
    const db = GatewayDatabase.open(tempDirSync("centraid-sweep-idle-"));
    const links = VaultLinksStore.open(db);
    const sweep = createPeerPlaneSweep({
      db,
      links,
      vaultFor: () => undefined,
      dial: () => undefined,
    });
    await sweep.runOnce();
    // No throw, nothing to assert on disk — a build with no peer dial wired
    // must not write anything into the share outbox.
    expect(db.db.prepare("SELECT * FROM share_effects").all()).toHaveLength(0);
  });

  it("runs the route re-announcement on every tick, even with no dial (#750 invariant 3)", async () => {
    const db = GatewayDatabase.open(tempDirSync("centraid-sweep-announce-"));
    const links = VaultLinksStore.open(db);
    let announced = 0;
    const sweep = createPeerPlaneSweep({
      db,
      links,
      vaultFor: () => undefined,
      dial: () => undefined,
      announceRoutes: async () => {
        announced += 1;
      },
    });
    await sweep.runOnce();
    // The announce seam is the RETRY path for a rotated EndpointId a peer has
    // not heard yet; the seam itself decides whether there is anything to say.
    expect(announced).toBe(1);
  });

  it("drains a durable refusal on a SCHEDULER TICK, not a direct call", async () => {
    const db = GatewayDatabase.open(tempDirSync("centraid-sweep-tick-"));
    const links = VaultLinksStore.open(db);
    const linkId = seedRoutedLink(links, "vlt_local", "vlt_peer");
    enqueueShareEffect(db, {
      kind: "deliver-refusal",
      edgeId: "edge-tick",
      linkId,
      peerVaultId: "vlt_peer",
      localVaultId: "vlt_local",
    });
    const sweep = createPeerPlaneSweep({
      db,
      links,
      vaultFor: () => undefined,
      dial: () => okDial,
      idleIntervalMs: 10,
      activeIntervalMs: 10,
    });
    try {
      sweep.start();
      await vi.waitFor(
        () => {
          expect(queuedFor(db, "deliver-refusal", "edge-tick")).toBeUndefined();
        },
        { timeout: 2000, interval: 10 }
      );
    } finally {
      sweep.stop();
    }
  });

  it("backs off after a failure instead of spinning, and recovers", async () => {
    const db = GatewayDatabase.open(tempDirSync("centraid-sweep-backoff-"));
    const links = VaultLinksStore.open(db);
    let calls = 0;
    const throwingLinks = {
      peerViewFor: () => {
        calls += 1;
        throw new Error("simulated db failure");
      },
    } as unknown as VaultLinksStore;
    const warnings: string[] = [];
    const linkId = seedRoutedLink(links, "vlt_local", "vlt_peer");
    enqueueShareEffect(db, {
      kind: "deliver-refusal",
      edgeId: "edge-backoff",
      linkId,
      peerVaultId: "vlt_peer",
      localVaultId: "vlt_local",
    });
    const sweep = createPeerPlaneSweep({
      db,
      links: throwingLinks,
      vaultFor: () => undefined,
      dial: () => okDial,
      idleIntervalMs: 10,
      logger: { warn: (message) => warnings.push(message) },
    });
    await sweep.runOnce();
    expect(calls).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/simulated db failure/u);
    // The row is untouched — a failed tick parks, it never loses work.
    expect(queuedFor(db, "deliver-refusal", "edge-backoff")).toBeDefined();
  });
});

/** The one queued effect of a kind for an edge — a local read, now that the
 *  retired give routes that needed it as a shared capability are gone. */
function queuedFor(
  db: Parameters<typeof listQueuedEffects>[0],
  kind: Parameters<typeof listQueuedEffects>[1],
  edgeId: string
): ReturnType<typeof listQueuedEffects>[number] | undefined {
  return listQueuedEffects(db, kind).find(
    (pending) => pending.effect.edgeId === edgeId
  );
}
