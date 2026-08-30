// The link-ticket store's sweep (#883 D4b): an abandoned pairing leaves a
// public key and a secret hash on the row `hasPending` reads.

import { setTimeout } from "node:timers";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { unrefTimer } from "../lib/unref-timer.js";
import { GatewayDatabase } from "./gateway-db.js";
import {
  DEFAULT_LINK_TICKET_TTL_MS,
  PeerLinkTicketStore,
} from "./peer-link-tickets.js";

async function store(): Promise<{
  tickets: PeerLinkTicketStore;
  db: GatewayDatabase;
  rows: () => number;
}> {
  const dir = await tempDir("peer-link-tickets-");
  const db = GatewayDatabase.open(dir);
  return {
    tickets: new PeerLinkTicketStore(db),
    db,
    rows: () =>
      (
        db.db.prepare("SELECT count(*) AS n FROM peer_link_tickets").get() as {
          n: number;
        }
      ).n,
  };
}

describe("peer link tickets", () => {
  test("an expired ticket leaves the table instead of accumulating", async () => {
    const { tickets, db, rows } = await store();
    tickets.mint("vault-2", "key-2", DEFAULT_LINK_TICKET_TTL_MS);
    tickets.mint("vault-1", "key-1", 1);
    expect(rows()).toBe(2);

    const removed = tickets.sweepExpired(Date.now() + 1_000);
    expect(removed).toBe(1);
    expect(rows()).toBe(1);
    db.close();
  });

  test("the sweep changes no answer the store gives", async () => {
    const { tickets, db } = await store();
    const live = tickets.mint("vault-2", "key-2", DEFAULT_LINK_TICKET_TTL_MS);
    const stale = tickets.mint("vault-1", "key-1", 1);

    expect(tickets.claim(stale.ticketId, stale.secret)).toBeUndefined();
    expect(tickets.hasPending()).toBe(true);
    const claimed = tickets.claim(live.ticketId, live.secret);
    expect(claimed).toStrictEqual(
      expect.objectContaining({ vaultId: "vault-2", vaultPublicKey: "key-2" })
    );
    expect(tickets.hasPending()).toBe(false);
    db.close();
  });

  test("asking about a FUTURE moment never deletes a ticket live now", async () => {
    // `hasPending(now)` answers a hypothetical: sweeping on the caller's `now`
    // would let a future-dated question destroy a ticket about to be redeemed.
    const { tickets, db, rows } = await store();
    const live = tickets.mint("vault-1", "key-1", DEFAULT_LINK_TICKET_TTL_MS);
    expect(tickets.hasPending(Date.now() + 16 * 60 * 1_000)).toBe(false);
    expect(rows()).toBe(1);
    expect(tickets.claim(live.ticketId, live.secret)).toStrictEqual(
      expect.objectContaining({ vaultId: "vault-1" })
    );
    db.close();
  });

  test("mint, hasPending and claim each carry the sweep", async () => {
    const operations = ["mint", "hasPending", "claim"] as const;
    const cases = await Promise.all(
      operations.map(async (operation) => ({ operation, ...(await store()) }))
    );
    for (const { operation, tickets, db, rows } of cases) {
      const expired = tickets.mint("vault-stale", "key", 1);
      expect(rows()).toBe(1);
      // Past the TTL by construction: 1 ms expires by the next statement.
      // oxlint-disable-next-line no-await-in-loop -- one settle per case, and the cases share no state
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5);
        unrefTimer(timer);
      });
      if (operation === "mint") tickets.mint("vault-2", "key-2");
      if (operation === "hasPending") tickets.hasPending();
      if (operation === "claim") tickets.claim(expired.ticketId, "wrong");
      expect(
        rows(),
        `${operation} must sweep the expired ticket it walked past`
      ).toBe(operation === "mint" ? 1 : 0);
      db.close();
    }
  });
});
