/*
 * The link ceremony's vault-side footprint (#821): approving a link on
 * both sides must leave a `share_party_vault_binding` row in the vault that
 * holds the party, revoking it must tombstone that row, and re-linking must
 * re-light the SAME row rather than trip the table's total UNIQUE key.
 *
 * The store is wired here exactly as `build-gateway.ts` wires it — a listener
 * that reconciles bindings — so these tests exercise the real path, not a
 * hand-called reconcile.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { openVaultDb, vaultIdentityPublicKey } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { GatewayDatabase } from "./gateway-db.js";
import { reconcileLinkBindings } from "./link-party-bindings.js";
import { VaultLinksStore } from "./vault-links-store.js";

const databases: GatewayDatabase[] = [];
const vaults: VaultDb[] = [];
const dirs: string[] = [];

const keyHome = vaultIdentityPublicKey(crypto.randomBytes(32)).toString(
  "base64"
);
const keyPeer = vaultIdentityPublicKey(crypto.randomBytes(32)).toString(
  "base64"
);

const HOME = "vault-home";
const PEER = "vault-peer";
const HOME_PARTY = "party-home";
const PEER_PARTY = "party-peer";

interface BindingRow {
  party_id: string;
  vault_id: string;
  vault_public_key: string | null;
  linked_at: string;
  revoked_at: string | null;
}

describe("link ceremony party↔vault bindings", () => {
  afterEach(async () => {
    for (const vault of vaults.splice(0)) vault.close();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  /** Both vaults co-hosted, so ONE gateway holds both sides of the link —
   *  the same-machine ceremony, and the case that exercises both directions
   *  of the reconcile in a single run. */
  async function open(): Promise<{
    store: VaultLinksStore;
    home: VaultDb;
    peer: VaultDb;
  }> {
    const dir = await tempDir("link-party-bindings-");
    dirs.push(dir);
    const database = GatewayDatabase.open(dir);
    databases.push(database);
    const home = openVaultDb();
    const peer = openVaultDb();
    vaults.push(home, peer);
    const mounted: Record<string, VaultDb> = { [HOME]: home, [PEER]: peer };
    const store: VaultLinksStore = new VaultLinksStore(database, (link) =>
      reconcileLinkBindings(link, {
        vaultFor: (vaultId) => mounted[vaultId],
        publicKeyFor: (vaultId) => store.directoryEntry(vaultId)?.publicKey,
        labelFor: (vaultId) =>
          store.directoryEntry(vaultId)?.label ?? undefined,
      })
    );
    return { store, home, peer };
  }

  function bindings(db: VaultDb): BindingRow[] {
    return db.vault
      .prepare(
        "SELECT * FROM share_party_vault_binding ORDER BY party_id, vault_id"
      )
      .all() as unknown as BindingRow[];
  }

  function proposeLink(store: VaultLinksStore) {
    return store.propose({
      fromVaultId: HOME,
      fromPublicKey: keyHome,
      toVaultId: PEER,
      toPublicKey: keyPeer,
      fromPartyId: HOME_PARTY,
      toPartyId: PEER_PARTY,
      fromLabel: "Home",
      toLabel: "Priya",
    });
  }

  test("a one-sided proposal writes no binding at all", async () => {
    const { store, home, peer } = await open();
    proposeLink(store);
    expect(bindings(home)).toStrictEqual([]);
    expect(bindings(peer)).toStrictEqual([]);
  });

  test("approving both sides binds each party to the other's vault", async () => {
    const { store, home, peer } = await open();
    const link = proposeLink(store);
    store.approve(link.linkId, PEER);

    // Home's vault learns "the person `party-peer` has vault `vault-peer`".
    const homeRows = bindings(home);
    expect(homeRows).toHaveLength(1);
    expect(homeRows[0]).toMatchObject({
      party_id: PEER_PARTY,
      vault_id: PEER,
      vault_public_key: keyPeer,
      revoked_at: null,
    });
    // …and the mirror image lands in the peer's vault, written by the same
    // reconcile because both vaults happen to be mounted on this gateway.
    expect(bindings(peer)).toHaveLength(1);
    expect(bindings(peer)[0]).toMatchObject({
      party_id: HOME_PARTY,
      vault_id: HOME,
      revoked_at: null,
    });
    // The binding's FK is satisfied by a mirrored party row, named from the
    // vault directory rather than left as a bare id.
    const party = home.vault
      .prepare("SELECT display_name FROM core_party WHERE party_id = ?")
      .get(PEER_PARTY) as { display_name: string };
    expect(party.display_name).toBe("Priya");
  });

  test("re-approving is idempotent — no second row, no UNIQUE failure", async () => {
    const { store, home } = await open();
    const link = proposeLink(store);
    store.approve(link.linkId, PEER);
    const first = bindings(home)[0]!;
    store.approve(link.linkId, PEER);
    store.approve(link.linkId, HOME);
    const after = bindings(home);
    expect(after).toHaveLength(1);
    expect(after[0]!.linked_at).toBe(first.linked_at);
  });

  test("revoking tombstones the binding; re-linking re-lights the same row", async () => {
    const { store, home } = await open();
    const link = proposeLink(store);
    store.approve(link.linkId, PEER);
    expect(store.revoke(link.linkId)).toBe(true);
    const revoked = bindings(home);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.revoked_at).not.toBeNull();

    // Re-linking the same pair. UNIQUE(party_id, vault_id) is total — it does
    // not exempt the tombstone — so this must re-light, never insert.
    store.gatewayDatabase.db
      .prepare("UPDATE vault_links SET revoked = 0 WHERE link_id = ?")
      .run(link.linkId);
    store.approve(link.linkId, PEER);
    const relit = bindings(home);
    expect(relit).toHaveLength(1);
    expect(relit[0]!.revoked_at).toBeNull();
  });

  test("a party already live-bound elsewhere is left alone, not re-pointed", async () => {
    const { store, home } = await open();
    // The peer party is already bound to a THIRD vault — the one-live-vault
    // rule says the standing binding wins and the ceremony reports a conflict
    // instead of violating the partial unique index.
    const now = new Date().toISOString();
    home.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, birth_date,
            avatar_content_id, created_at, updated_at, ontology_version)
         VALUES (?, 'person', 'Priya', 'Priya', NULL, NULL, ?, ?, '1.4')`
      )
      .run(PEER_PARTY, now, now);
    home.vault
      .prepare(
        `INSERT INTO share_party_vault_binding
           (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
         VALUES ('existing', ?, 'vault-elsewhere', NULL, ?, NULL)`
      )
      .run(PEER_PARTY, now);

    const link = proposeLink(store);
    // No throw: the conflict is an outcome the ceremony reports, not an error.
    expect(() => store.approve(link.linkId, PEER)).not.toThrow();
    const rows = bindings(home);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      vault_id: "vault-elsewhere",
      revoked_at: null,
    });
  });

  test("reconcile reports per-side outcomes, and skips vaults living elsewhere", async () => {
    const { store, home } = await open();
    const link = proposeLink(store);
    const approved = store.approve(link.linkId, PEER)!;
    // Only HOME is mounted for this call: the peer side is somebody else's
    // gateway, which is exactly what an absent `vaultFor` means (#750 inv. 2).
    const outcomes = reconcileLinkBindings(approved, {
      vaultFor: (vaultId) => (vaultId === HOME ? home : undefined),
    });
    expect(outcomes).toStrictEqual([
      {
        localVaultId: HOME,
        peerVaultId: PEER,
        partyId: PEER_PARTY,
        state: "bound",
      },
    ]);
  });

  test("a link that exchanged no party identity binds nothing", async () => {
    const { store, home, peer } = await open();
    const link = store.propose({
      fromVaultId: HOME,
      fromPublicKey: keyHome,
      toVaultId: PEER,
      toPublicKey: keyPeer,
    });
    store.approve(link.linkId, PEER);
    expect(bindings(home)).toStrictEqual([]);
    expect(bindings(peer)).toStrictEqual([]);
  });
});
