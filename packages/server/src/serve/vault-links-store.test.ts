/*
 * The link store over its three tables (issue #726 P2 §3 + P3 decisions 1–4,
 * reshaped by issue #750): `vault_links` is pure permission, `vault_directory`
 * is one identity record per known vault, and `vault_routes` is ONE row per
 * vault that lives elsewhere — a pair on this machine and a pair across the
 * world are the same link rows, differing only in whether the far vault has a
 * route row.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";

import { describe, afterEach, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { vaultIdentityPublicKey } from "@centraid/vault";

import { GatewayDatabase } from "./gateway-db.js";
import { isLinkApproved } from "./vault-link-row.js";
import { VaultLinksStore } from "./vault-links-store.js";

const databases: GatewayDatabase[] = [];
const dirs: string[] = [];

const keyA = vaultIdentityPublicKey(crypto.randomBytes(32)).toString("base64");
const keyB = vaultIdentityPublicKey(crypto.randomBytes(32)).toString("base64");

function proposal(store: VaultLinksStore, from: string, to: string) {
  return store.propose({
    fromVaultId: from,
    fromPublicKey: keyA,
    toVaultId: to,
    toPublicKey: keyB,
  });
}

function remoteLink(
  store: VaultLinksStore,
  overrides: Record<string, unknown> = {}
) {
  const ticket = store.tickets.mint("vault-local", keyA);
  return {
    ticket,
    link: store.redeem({
      ticketId: ticket.ticketId,
      secret: ticket.secret,
      peerVaultId: "vault-peer",
      peerPublicKey: keyB,
      route: {
        endpointId: "ep-peer",
        relayHints: ["https://relay.example"],
        assertedAt: Date.now(),
      },
      peerLabel: "Priya",
      localLabel: "Home",
      ...overrides,
    }),
  };
}

describe(VaultLinksStore, () => {
  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  async function open(): Promise<VaultLinksStore> {
    const dir = await tempDir("vault-links-store-");
    dirs.push(dir);
    const database = GatewayDatabase.open(dir);
    databases.push(database);
    return new VaultLinksStore(database);
  }

  test("propose normalizes the pair regardless of argument order", async () => {
    const store = await open();
    const proposed = proposal(store, "vault-b", "vault-a");
    expect(proposed.vaultA).toBe("vault-a");
    expect(proposed.vaultB).toBe("vault-b");
    expect(store.findPair("vault-a", "vault-b")?.linkId).toBe(proposed.linkId);
    expect(store.findPair("vault-b", "vault-a")?.linkId).toBe(proposed.linkId);
  });

  test("a local pair records both identities in the directory and no route", async () => {
    const store = await open();
    proposal(store, "vault-a", "vault-b");
    expect(store.directoryEntry("vault-a")?.publicKey).toBe(keyA);
    expect(store.directoryEntry("vault-b")?.publicKey).toBe(keyB);
    // No `vault_routes` row IS what "on this gateway" means (#750).
    expect(store.routeFor("vault-a")).toBeUndefined();
    expect(store.routeFor("vault-b")).toBeUndefined();
    // Nothing routed means nothing the peer plane will admit.
    expect(store.hasAnyLink()).toBe(false);
  });

  test("propose marks only the proposer's side approved", async () => {
    const store = await open();
    const link = proposal(store, "vault-b", "vault-a");
    expect(link.approvedByA).toBeNull();
    expect(link.approvedByB).not.toBeNull();
    expect(isLinkApproved(link)).toBe(false);
  });

  test("propose is idempotent: proposing the same pair again returns the same row", async () => {
    const store = await open();
    const first = proposal(store, "vault-a", "vault-b");
    const second = proposal(store, "vault-a", "vault-b");
    expect(second.linkId).toBe(first.linkId);
    expect(second.approvedByA).toBe(first.approvedByA);
  });

  test("approve requires BOTH sides, and is idempotent", async () => {
    const store = await open();
    const link = proposal(store, "vault-a", "vault-b");
    const approved = store.approve(link.linkId, "vault-b")!;
    expect(isLinkApproved(approved)).toBe(true);
    const reapproved = store.approve(link.linkId, "vault-b")!;
    expect(reapproved.approvedByB).toBe(approved.approvedByB);
  });

  test("approve refuses a vault id that names neither side, or an unknown link", async () => {
    const store = await open();
    const link = proposal(store, "vault-a", "vault-b");
    expect(store.approve(link.linkId, "vault-c")).toBeUndefined();
    expect(store.approve("nonexistent", "vault-a")).toBeUndefined();
  });

  test("listForOwner finds every link naming a vault that owner owns, on either side", async () => {
    const dir = await tempDir("vault-links-store-");
    dirs.push(dir);
    const database = GatewayDatabase.open(dir);
    databases.push(database);
    database.run(
      "INSERT INTO owners (owner_id, label, created_at) VALUES ('owner-1', 'Priya', 0)"
    );
    database.run(
      "INSERT INTO vault_owners (vault_id, owner_id) VALUES ('vault-a', 'owner-1')"
    );
    const store = new VaultLinksStore(database);
    const linkAB = proposal(store, "vault-a", "vault-b");
    proposal(store, "vault-c", "vault-d");
    expect(
      store.listForOwner("owner-1").map((link) => link.linkId)
    ).toStrictEqual([linkAB.linkId]);
    expect(store.listForOwner("owner-2")).toStrictEqual([]);
  });

  test("the remote ceremony fills the SAME approval columns a local one does", async () => {
    const store = await open();
    const { link } = remoteLink(store);
    expect(link?.peerVaultId).toBe("vault-peer");
    // Minting the ticket was one side's approval, redeeming it the other's.
    expect(isLinkApproved(store.findPair("vault-local", "vault-peer")!)).toBe(
      true
    );
  });

  test("redeems exactly once, and the second attempt sees nothing", async () => {
    const store = await open();
    const { ticket } = remoteLink(store);
    expect(
      store.redeem({
        ticketId: ticket.ticketId,
        secret: ticket.secret,
        peerVaultId: "vault-attacker",
        peerPublicKey: keyB,
        route: { endpointId: "ep-attacker", relayHints: [], assertedAt: 1 },
        peerLabel: "x",
        localLabel: "Home",
      })
    ).toBeUndefined();
    expect(store.list()).toHaveLength(1);
    expect(store.peerForEndpoint("ep-attacker")).toBeUndefined();
  });

  test("stores the ticket secret only as a hash", async () => {
    const store = await open();
    const ticket = store.tickets.mint("vault-local", keyA);
    const row = store.gatewayDatabase.db
      .prepare("SELECT secret_hash FROM peer_link_tickets WHERE ticket_id = ?")
      .get(ticket.ticketId) as { secret_hash: string };
    expect(row.secret_hash).not.toBe(ticket.secret);
    expect(row.secret_hash).toHaveLength(64);
  });

  test("a revoked link goes invisible without being forgotten", async () => {
    const store = await open();
    const { link } = remoteLink(store);
    expect(store.revoke(link!.linkId)).toBe(true);
    expect(store.peerForEndpoint("ep-peer")).toBeUndefined();
    expect(store.isLinked("ep-peer")).toBe(false);
    expect(store.hasAnyLink()).toBe(false);
    expect(store.list()).toHaveLength(1);
  });

  test("the route is replaceable cache; the identity survives the move", async () => {
    const store = await open();
    const { link } = remoteLink(store);
    expect(
      store.recordRoute({
        peerVaultId: "vault-peer",
        peerEndpointId: "ep-rotated",
        peerRelayHints: ["https://relay2.example"],
        assertedAt: Date.now() + 5000,
        signature: "sig",
      })
    ).toBe(true);
    const after = store.peerForEndpoint("ep-rotated");
    expect(after?.linkId).toBe(link!.linkId);
    expect(after?.peerPublicKey).toBe(keyB);
    expect(store.peerForEndpoint("ep-peer")).toBeUndefined();
  });

  test("an older assertion never wins the route back", async () => {
    const store = await open();
    remoteLink(store);
    const at = Date.now() + 5000;
    expect(
      store.recordRoute({
        peerVaultId: "vault-peer",
        peerEndpointId: "ep-new",
        peerRelayHints: [],
        assertedAt: at,
      })
    ).toBe(true);
    expect(
      store.recordRoute({
        peerVaultId: "vault-peer",
        peerEndpointId: "ep-replayed",
        peerRelayHints: [],
        assertedAt: at - 1,
      })
    ).toBe(false);
    expect(store.peerForEndpoint("ep-new")).toBeTruthy();
  });

  test("a vault on this gateway cannot be route-asserted", async () => {
    const store = await open();
    proposal(store, "vault-a", "vault-b");
    expect(
      store.recordRoute({
        peerVaultId: "vault-b",
        peerEndpointId: "ep-forged",
        peerRelayHints: [],
        assertedAt: Date.now(),
      })
    ).toBe(false);
    expect(store.peerForEndpoint("ep-forged")).toBeUndefined();
  });

  test("linkForEndpoint is ambiguous when two vaults share an endpoint; linkForPeer is not (#726 audit finding 2)", async () => {
    // An iroh endpoint is per-GATEWAY, not per-vault (D1 invariant 2) — two
    // vaults co-hosted on one remote gateway route through the SAME
    // endpointId, exactly like `vault-x`/`vault-y` here.
    const store = await open();
    const { link: linkToX } = remoteLink(store, {
      peerVaultId: "vault-x",
      route: { endpointId: "ep-household", relayHints: [], assertedAt: 1 },
    });
    const { link: linkToY } = remoteLink(store, {
      peerVaultId: "vault-y",
      route: { endpointId: "ep-household", relayHints: [], assertedAt: 1 },
    });
    expect(linkToX!.linkId).not.toBe(linkToY!.linkId);

    // The endpoint-only lookup cannot tell the two apart — it resolves to
    // WHICHEVER row the query happens to return, silently.
    const ambiguous = store.linkForEndpoint("ep-household");
    expect(ambiguous).toBeTruthy();

    // Naming the peer vault disambiguates exactly.
    expect(store.linkForPeer("ep-household", "vault-x")?.linkId).toBe(
      linkToX!.linkId
    );
    expect(store.linkForPeer("ep-household", "vault-y")?.linkId).toBe(
      linkToY!.linkId
    );
    expect(store.linkForPeer("ep-household", "vault-nobody")).toBeUndefined();

    expect(
      store.peerForEndpointAndVault("ep-household", "vault-x")
    ).toMatchObject({ localVaultId: "vault-local", peerVaultId: "vault-x" });
    expect(
      store.peerForEndpointAndVault("ep-household", "vault-y")
    ).toMatchObject({ localVaultId: "vault-local", peerVaultId: "vault-y" });
  });

  test("one signed-route slot serves EVERY link to a peer vault (#750 invariants 1–2)", async () => {
    // Two LOCAL vaults link to the SAME peer vault — the household shape that
    // must not duplicate the peer's key/label/route across two rows, where a
    // later assertion would update only whichever row a lookup found first.
    const store = await open();
    for (const local of ["vault-local-1", "vault-local-2"]) {
      const ticket = store.tickets.mint(local, keyA);
      expect(
        store.redeem({
          ticketId: ticket.ticketId,
          secret: ticket.secret,
          peerVaultId: "vault-peer",
          peerPublicKey: keyB,
          route: { endpointId: "ep-first", relayHints: [], assertedAt: 1 },
          peerLabel: "Priya",
          localLabel: local,
        })
      ).toBeTruthy();
    }
    expect(store.list()).toHaveLength(2);
    // ONE directory record, ONE route row — by construction, not by sweep.
    const directoryRows = store.gatewayDatabase.db
      .prepare("SELECT count(*) AS n FROM vault_directory WHERE vault_id = ?")
      .get("vault-peer") as { n: number };
    expect(directoryRows.n).toBe(1);
    const routeRows = store.gatewayDatabase.db
      .prepare("SELECT count(*) AS n FROM vault_routes")
      .get() as { n: number };
    expect(routeRows.n).toBe(1);

    // ONE assertion moves the route BOTH links resolve.
    expect(
      store.recordRoute({
        peerVaultId: "vault-peer",
        peerEndpointId: "ep-moved",
        peerRelayHints: ["https://relay2.example"],
        assertedAt: Date.now() + 5000,
      })
    ).toBe(true);
    for (const local of ["vault-local-1", "vault-local-2"]) {
      const view = store.peerForVault("vault-peer", local);
      expect(view?.route.endpointId).toBe("ep-moved");
      expect(view?.peerPublicKey).toBe(keyB);
    }
  });

  test("the DDL keeps an EndpointId in vault_routes and nowhere else in the link tables", async () => {
    const store = await open();
    const ddl = new Map(
      (
        store.gatewayDatabase.db
          .prepare(
            `SELECT name, sql FROM sqlite_schema
              WHERE type = 'table'
                AND name IN ('vault_links', 'vault_directory', 'share_edges', 'share_access_receipts')`
          )
          .all() as unknown as Array<{ name: string; sql: string }>
      ).map((row) => [row.name, row.sql] as const)
    );
    expect(ddl.size).toBe(4);
    for (const sql of ddl.values()) {
      for (const match of sql.matchAll(
        /^\s+(?<column>[a-z_]+)\s+(?:TEXT|INTEGER|REAL|BLOB)/gmu
      )) {
        expect(match.groups?.column).not.toMatch(/endpoint/u);
      }
    }
    // A link row is pure permission (#750): identity and routing live in the
    // directory tables, so nothing here can drift per link.
    const links = ddl.get("vault_links")!;
    for (const retired of [
      "public_key",
      "label_",
      "route_a_json",
      "route_b_json",
    ]) {
      expect(links).not.toContain(retired);
    }
  });
});
