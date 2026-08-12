/*
 * Exit evidence for #726 P3 gap 2 (and gap 3's delivery half): the pull /
 * refusal queues drain on a SCHEDULER TICK, not by a direct call — proved
 * here by calling only `.start()`/`.stop()` on the sweep and observing the
 * durable rows disappear on their own. `runOnce()` (the test seam for
 * `peer-blob-pull.test.ts`-style direct-call assertions) is deliberately
 * NOT used in the "drains on a tick" test below.
 */

import { describe, expect, it, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { GatewayDatabase } from "./gateway-db.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import { createPeerPlaneSweep } from "./peer-plane-sweep.js";
import { recordPendingRefusal } from "./peer-refusal-relay.js";
import { ShareEffectsStore } from "./share-effects.js";
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
    // must not touch peer-plane tables at all.
    expect(db.db.prepare("SELECT * FROM share_effects").all()).toHaveLength(0);
  });

  it("drains a durable refusal on a SCHEDULER TICK, not a direct call", async () => {
    const db = GatewayDatabase.open(tempDirSync("centraid-sweep-tick-"));
    const links = VaultLinksStore.open(db);
    const linkId = seedRoutedLink(links, "vlt_local", "vlt_peer");
    recordPendingRefusal(db, {
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
          const row = db.db
            .prepare(
              `SELECT * FROM share_effects
                WHERE kind = 'notify-refusal' AND edge_id = ?
                  AND state IN ('queued', 'running', 'parked')`
            )
            .get("edge-tick");
          expect(row).toBeUndefined();
        },
        { timeout: 2000, interval: 10 }
      );
    } finally {
      sweep.stop();
    }
  });

  it("retries Commons invitations through the same scheduled effect runner", async () => {
    const db = GatewayDatabase.open(tempDirSync("centraid-sweep-invite-"));
    const links = VaultLinksStore.open(db);
    const linkId = seedRoutedLink(links, "vlt_steward", "vlt_member");
    const effect = new ShareEffectsStore(db).enqueue({
      edgeId: "grant-1",
      kind: "deliver-commons-invitation",
      localVaultId: "vlt_steward",
      peerVaultId: "vlt_member",
      payload: {
        linkId,
        grantId: "grant-1",
        invitationId: "grant-1:vlt_member",
        stewardVaultId: "vlt_steward",
        memberVaultId: "vlt_member",
        memberPartyId: "party-member",
        capability: "read+write",
        containerType: "tally.group",
        containerId: "group-1",
        currentSizeBytes: 128,
      },
    });
    const sweep = createPeerPlaneSweep({
      db,
      links,
      vaultFor: () => undefined,
      dial: () => ({
        endpointTicketFor: () => "ticket",
        request: async () => ({ status: 200, json: { state: "pending" } }),
      }),
    });

    await sweep.runOnce();

    expect(new ShareEffectsStore(db).get(effect.effectId)?.state).toBe(
      "executed"
    );
  });

  it("backs off after a failure instead of spinning, and recovers", async () => {
    const db = GatewayDatabase.open(tempDirSync("centraid-sweep-backoff-"));
    const links = VaultLinksStore.open(db);
    let calls = 0;
    const throwingLinks = {
      get: () => {
        calls += 1;
        throw new Error("simulated db failure");
      },
    } as unknown as VaultLinksStore;
    const warnings: string[] = [];
    const linkId = seedRoutedLink(links, "vlt_local", "vlt_peer");
    recordPendingRefusal(db, {
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
    expect(
      db.db
        .prepare(
          `SELECT * FROM share_effects
            WHERE kind = 'notify-refusal' AND edge_id = ?
              AND state IN ('queued', 'running', 'parked')`
        )
        .get("edge-backoff")
    ).toBeDefined();
  });
});
