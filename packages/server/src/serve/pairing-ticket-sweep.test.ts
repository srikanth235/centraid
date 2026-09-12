/*
 * An unredeemed pairing ticket does not outlive its expiry (#1014, X18).
 *
 * `tickets` rows were deleted only on redemption or vault erase, so every
 * invitation an owner minted and never used stayed in `gateway.db` forever.
 */

import { promises as fs } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { GatewayDatabase } from "./gateway-db.ts";
import { OwnerStore } from "./owner-store.ts";
import { PairingTicketStore } from "./pairing-store.ts";

let dataDir: string;
let database: GatewayDatabase;

describe("pairing ticket sweep", () => {
  beforeEach(async () => {
    dataDir = await tempDir("pairing-sweep-");
    database = GatewayDatabase.open(dataDir);
  });

  afterEach(async () => {
    database.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("minting sweeps every ticket whose expiry has passed", () => {
    const tickets = PairingTicketStore.open(database);
    const owner = OwnerStore.open(database).create("Priya");
    const invitation = { ownerId: owner.ownerId, vaultIds: ["vault-1"] };
    const stale = tickets.mint(invitation, 5);
    const live = tickets.mint(invitation, 10 * 60_000);
    const countRows = (): number =>
      (
        database.db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as {
          n: number;
        }
      ).n;
    expect(countRows()).toBe(2);

    // Past the stale ticket's expiry, the next mint takes it with it.
    const clock = Date.now() + 10;
    const realNow = Date.now;
    Date.now = () => clock;
    try {
      tickets.mint(invitation, 10 * 60_000);
    } finally {
      Date.now = realNow;
    }

    const remaining = database.db
      .prepare("SELECT ticket_id FROM tickets ORDER BY ticket_id")
      .all() as { ticket_id: string }[];
    const ids = remaining.map((row) => row.ticket_id);
    expect(ids).not.toContain(stale.ticketId);
    expect(ids).toContain(live.ticketId);
    expect(ids).toHaveLength(2);
    // An expired ticket is unredeemable whether or not it has been swept.
    expect(tickets.redeem(stale.ticketId, stale.secret)).toBeUndefined();
  });
});
