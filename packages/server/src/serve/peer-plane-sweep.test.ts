/*
 * The peer plane's adaptive tick, after the share effect outbox left it with
 * the give plane (#928 A7). Two concerns remain, and both are exercised here:
 * the route re-announcement runs on EVERY tick (#750 invariant 3), and a
 * failing tick backs off with a stated reason instead of spinning.
 *
 * A same-owner placement is no longer a durable obligation this sweep drains —
 * it is one synchronous vault call at `routes/placement-routes.ts`.
 */

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { GatewayDatabase } from "./gateway-db.js";
import { createPeerPlaneSweep } from "./peer-plane-sweep.js";
import { VaultLinksStore } from "./vault-links-store.js";

describe("peer plane sweep (#726 P3 gap 2)", () => {
  it("runs the route re-announcement on every tick, even with no dial (#750 invariant 3)", async () => {
    const db = GatewayDatabase.open(tempDirSync("centraid-sweep-announce-"));
    const links = VaultLinksStore.open(db);
    let announced = 0;
    const sweep = createPeerPlaneSweep({
      db,
      links,
      vaultFor: () => undefined,
      partyIdFor: () => undefined,
      dial: () => undefined,
      announceRoutes: async () => {
        announced += 1;
      },
    });
    await sweep.runOnce();
    // The announce seam is the RETRY path for a rotated EndpointId a peer has
    // not heard yet; the seam itself decides whether there is anything to say.
    expect(announced).toBe(1);
    db.close();
  });

  it("backs off after a failure instead of spinning, and states the reason", async () => {
    const db = GatewayDatabase.open(tempDirSync("centraid-sweep-backoff-"));
    const links = VaultLinksStore.open(db);
    const warnings: string[] = [];
    const sweep = createPeerPlaneSweep({
      db,
      links,
      vaultFor: () => undefined,
      partyIdFor: () => undefined,
      dial: () => undefined,
      announceRoutes: () => {
        throw new Error("simulated announce failure");
      },
      idleIntervalMs: 10,
      logger: { warn: (message) => warnings.push(message) },
    });
    await sweep.runOnce();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/simulated announce failure/u);
    db.close();
  });
});
