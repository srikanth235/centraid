/*
 * The one store answering "may an edge cross between these two vaults" and
 * "where does that vault live" (#726, #750 invariants 1–2). `vault_directory`
 * holds ONE identity record per vault, written by the ceremony and never by a
 * route assertion — a route is never identity. `vault_routes` holds ONE row
 * per vault that lives elsewhere, and its mere presence is what "remote"
 * means. `vault_links` is pure permission, stored smaller-id-first so lookup
 * is order-independent, and an edge crosses only with BOTH sides approved.
 */ import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";

import { GatewayDatabase } from "./gateway-db.js";
import { PeerLinkTicketStore } from "./peer-link-tickets.js";
import {
  directoryEntryOf,
  routeOf,
  upsertDirectoryRow,
  upsertRouteRow,
} from "./vault-directory-store.js";
import type {
  LinkChangeListener,
  LinkChangeReason,
  LinkedPeer,
  LinkRedemption,
  LinkRoute,
  PeerLinkInput,
  VaultDirectoryEntry,
  VaultLink,
  VaultLinkRow,
} from "./vault-link-row.js";
import { pairOf, peerViewOf, sideOf, toLink } from "./vault-link-row.js";

function databaseFor(source: string | GatewayDatabase): GatewayDatabase {
  if (source instanceof GatewayDatabase) return source;
  return GatewayDatabase.open(path.dirname(path.resolve(source)));
}

export class VaultLinksStore {
  readonly gatewayDatabase: GatewayDatabase;
  readonly tickets: PeerLinkTicketStore;
  private readonly onLinkChanged: LinkChangeListener | undefined;

  constructor(
    gatewayDatabase: GatewayDatabase,
    onLinkChanged?: LinkChangeListener
  ) {
    this.gatewayDatabase = gatewayDatabase;
    this.tickets = new PeerLinkTicketStore(gatewayDatabase);
    this.onLinkChanged = onLinkChanged;
  }

  static open(
    source: string | GatewayDatabase,
    onLinkChanged?: LinkChangeListener
  ): VaultLinksStore {
    return new VaultLinksStore(databaseFor(source), onLinkChanged);
  }

  private announce<T extends VaultLink | undefined>(
    link: T,
    reason: LinkChangeReason
  ): T {
    if (link) this.onLinkChanged?.(link, reason);
    return link;
  }

  private row(sql: string, ...params: SQLInputValue[]): VaultLink | undefined {
    const row = this.gatewayDatabase.db.prepare(sql).get(...params);
    return row ? toLink(row as unknown as VaultLinkRow) : undefined;
  }

  private rows(sql: string, ...params: SQLInputValue[]): VaultLink[] {
    return (
      this.gatewayDatabase.db
        .prepare(sql)
        .all(...params) as unknown as VaultLinkRow[]
    ).map(toLink);
  }

  get(linkId: string): VaultLink | undefined {
    return this.row("SELECT * FROM vault_links WHERE link_id = ?", linkId);
  }

  /** Named `findPair`, not `find`: oxlint's
   *  `unicorn/no-array-method-this-argument` mis-matches any two-arg `.find`. */
  findPair(vaultX: string, vaultY: string): VaultLink | undefined {
    const [a, b] = pairOf(vaultX, vaultY);
    return this.row(
      "SELECT * FROM vault_links WHERE vault_a = ? AND vault_b = ?",
      a,
      b
    );
  }

  listFor(vaultId: string): VaultLink[] {
    return this.rows(
      `SELECT * FROM vault_links
        WHERE vault_a = ? OR vault_b = ?
        ORDER BY created_at`,
      vaultId,
      vaultId
    );
  }

  listForOwner(ownerId: string): VaultLink[] {
    return this.rows(
      `SELECT * FROM vault_links vl
        WHERE EXISTS (
          SELECT 1 FROM vault_owners vo
           WHERE vo.owner_id = ?
             AND (vo.vault_id = vl.vault_a OR vo.vault_id = vl.vault_b)
        )
        ORDER BY vl.created_at`,
      ownerId
    );
  }

  list(): VaultLink[] {
    return this.rows("SELECT * FROM vault_links ORDER BY created_at");
  }

  directoryEntry(vaultId: string): VaultDirectoryEntry | undefined {
    return directoryEntryOf(this.gatewayDatabase, vaultId);
  }

  /** `undefined` when `vaultId` lives on this gateway (#750 invariant 2). */
  routeFor(vaultId: string): LinkRoute | undefined {
    return routeOf(this.gatewayDatabase, vaultId);
  }

  private upsertDirectory(
    vaultId: string,
    publicKey: string,
    label: string | null,
    createdAt: string
  ): void {
    upsertDirectoryRow(
      this.gatewayDatabase,
      vaultId,
      publicKey,
      label,
      createdAt
    );
  }

  private upsertRoute(vaultId: string, route: LinkRoute): void {
    upsertRouteRow(this.gatewayDatabase, vaultId, route);
  }

  private peerView(
    link: VaultLink,
    localVaultId: string
  ): LinkedPeer | undefined {
    return peerViewOf(link, localVaultId, this);
  }

  peerViewFor(linkId: string, localVaultId: string): LinkedPeer | undefined {
    const link = this.get(linkId);
    if (!link || link.revoked) return undefined;
    return this.peerView(link, localVaultId);
  }

  propose(input: {
    fromVaultId: string;
    fromPublicKey: string;
    toVaultId: string;
    toPublicKey: string;
    fromPartyId?: string;
    toPartyId?: string;
    fromLabel?: string;
    toLabel?: string;
    now?: () => number;
  }): VaultLink {
    const existing = this.findPair(input.fromVaultId, input.toVaultId);
    if (existing) return existing;
    const [a, b] = pairOf(input.fromVaultId, input.toVaultId);
    const fromIsA = input.fromVaultId === a;
    const linkId = randomUUID();
    const createdAt = new Date((input.now ?? Date.now)()).toISOString();
    const proposed = this.gatewayDatabase.transaction(() => {
      this.upsertDirectory(
        input.fromVaultId,
        input.fromPublicKey,
        input.fromLabel ?? null,
        createdAt
      );
      this.upsertDirectory(
        input.toVaultId,
        input.toPublicKey,
        input.toLabel ?? null,
        createdAt
      );
      // The other side stays NULL until that owner's device approves.
      this.gatewayDatabase.run(
        `INSERT INTO vault_links (
           link_id, vault_a, vault_b, approved_by_a, approved_by_b,
           permissions_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        linkId,
        a,
        b,
        fromIsA ? createdAt : null,
        fromIsA ? null : createdAt,
        JSON.stringify(
          input.fromPartyId && input.toPartyId
            ? {
                commonsPartyIds: {
                  [input.fromVaultId]: input.fromPartyId,
                  [input.toVaultId]: input.toPartyId,
                },
              }
            : {}
        ),
        createdAt
      );
      return this.get(linkId)!;
    });
    return this.announce(proposed, "proposed");
  }

  /** `undefined` when `vaultId` names neither side — the caller refuses
   *  without leaking which side was wrong. */
  approve(
    linkId: string,
    vaultId: string,
    now: () => number = Date.now
  ): VaultLink | undefined {
    const link = this.get(linkId);
    if (!link) return undefined;
    const side = sideOf(link, vaultId);
    if (side === undefined) return undefined;
    const already = side === "a" ? link.approvedByA : link.approvedByB;
    if (!already) {
      this.gatewayDatabase.run(
        side === "a"
          ? "UPDATE vault_links SET approved_by_a = ? WHERE link_id = ?"
          : "UPDATE vault_links SET approved_by_b = ? WHERE link_id = ?",
        new Date(now()).toISOString(),
        linkId
      );
    }
    return this.announce(this.get(linkId)!, "approved");
  }

  recordPeer(
    input: PeerLinkInput,
    approvals?: {
      local: string;
      peer: string;
    }
  ): LinkedPeer | undefined {
    const peer = this.gatewayDatabase.transaction(() =>
      this.writePeer(input, approvals)
    );
    this.announce(
      this.findPair(input.localVaultId, input.peerVaultId),
      "linked"
    );
    return peer;
  }

  /** Callable inside an open transaction — SQLite's do not nest. */
  private writePeer(
    input: PeerLinkInput,
    approvals?: {
      local: string;
      peer: string;
    }
  ): LinkedPeer | undefined {
    const [a, b] = pairOf(input.localVaultId, input.peerVaultId);
    const localIsA = input.localVaultId === a;
    const now = new Date().toISOString();
    const localApproval = approvals?.local ?? now;
    const peerApproval = approvals?.peer ?? now;
    this.upsertDirectory(
      input.localVaultId,
      input.localPublicKey,
      input.localLabel,
      now
    );
    this.upsertDirectory(
      input.peerVaultId,
      input.peerPublicKey,
      input.peerLabel,
      now
    );
    this.upsertRoute(input.peerVaultId, input.route);
    this.gatewayDatabase.run(
      `INSERT INTO vault_links (
         link_id, vault_a, vault_b, approved_by_a, approved_by_b,
         permissions_json, revoked, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT (vault_a, vault_b) DO UPDATE SET
         approved_by_a = excluded.approved_by_a,
         approved_by_b = excluded.approved_by_b,
         permissions_json = excluded.permissions_json,
         revoked = 0`,
      randomUUID(),
      a,
      b,
      localIsA ? localApproval : peerApproval,
      localIsA ? peerApproval : localApproval,
      JSON.stringify(input.permissions ?? {}),
      now
    );
    return this.peerForVault(input.peerVaultId, input.localVaultId);
  }

  recordCommonsParties(input: {
    localVaultId: string;
    localPartyId: string;
    peerVaultId: string;
    peerPartyId: string;
  }): LinkedPeer | undefined {
    const link = this.findPair(input.localVaultId, input.peerVaultId);
    if (!link || link.revoked) return undefined;
    const existing =
      typeof link.permissions["commonsPartyIds"] === "object" &&
      link.permissions["commonsPartyIds"] !== null
        ? (link.permissions["commonsPartyIds"] as Record<string, unknown>)
        : {};
    const permissions = {
      ...link.permissions,
      commonsPartyIds: {
        ...existing,
        [input.localVaultId]: input.localPartyId,
        [input.peerVaultId]: input.peerPartyId,
      },
    };
    this.gatewayDatabase.run(
      "UPDATE vault_links SET permissions_json = ? WHERE link_id = ?",
      JSON.stringify(permissions),
      link.linkId
    );
    this.announce(this.get(link.linkId), "parties");
    return this.peerForVault(input.peerVaultId, input.localVaultId);
  }

  /**
   * Burn and write in ONE transaction, so a ticket can never be redeemed
   * twice. The directory records the key the TICKET promised.
   */
  redeem(input: LinkRedemption): LinkedPeer | undefined {
    const peer = this.gatewayDatabase.transaction(() => {
      const claimed = this.tickets.claim(input.ticketId, input.secret);
      if (!claimed) return undefined;
      return this.writePeer(
        {
          localVaultId: claimed.vaultId,
          localPublicKey: claimed.vaultPublicKey,
          localLabel: input.localLabel,
          peerVaultId: input.peerVaultId,
          peerPublicKey: input.peerPublicKey,
          peerLabel: input.peerLabel,
          route: input.route,
          ...(input.permissions === undefined
            ? {}
            : { permissions: input.permissions }),
        },
        { local: claimed.createdAt, peer: new Date().toISOString() }
      );
    });
    if (peer)
      this.announce(
        this.findPair(peer.localVaultId, peer.peerVaultId),
        "linked"
      );
    return peer;
  }

  linkForEndpoint(peerEndpointId: string): VaultLink | undefined {
    return this.row(
      `SELECT vl.* FROM vault_links vl
        JOIN vault_routes vr
          ON vr.vault_id IN (vl.vault_a, vl.vault_b)
        WHERE vl.revoked = 0 AND vr.endpoint_id = ?
        LIMIT 1`,
      peerEndpointId
    );
  }

  peerForEndpoint(peerEndpointId: string): LinkedPeer | undefined {
    const link = this.linkForEndpoint(peerEndpointId);
    if (!link) return undefined;
    const localVaultId =
      this.routeFor(link.vaultA)?.endpointId === peerEndpointId
        ? link.vaultB
        : link.vaultA;
    return this.peerView(link, localVaultId);
  }

  /**
   * An endpoint is per-GATEWAY, so co-hosted vaults share one and
   * `linkForEndpoint` cannot tell which a request concerns. Every route
   * attributing an edge MUST resolve through here, on a vault id the REQUEST
   * claims, so a stale claim resolves to nothing (#726).
   */
  linkForPeer(
    peerEndpointId: string,
    peerVaultId: string
  ): VaultLink | undefined {
    return this.row(
      `SELECT vl.* FROM vault_links vl
        JOIN vault_routes vr
          ON vr.vault_id = ? AND vr.endpoint_id = ?
        WHERE vl.revoked = 0 AND ? IN (vl.vault_a, vl.vault_b)
        LIMIT 1`,
      peerVaultId,
      peerEndpointId,
      peerVaultId
    );
  }

  peerForEndpointAndVault(
    peerEndpointId: string,
    peerVaultId: string
  ): LinkedPeer | undefined {
    const link = this.linkForPeer(peerEndpointId, peerVaultId);
    if (!link) return undefined;
    const localVaultId =
      link.vaultA === peerVaultId ? link.vaultB : link.vaultA;
    return this.peerView(link, localVaultId);
  }

  isLinked(peerEndpointId: string): boolean {
    return this.linkForEndpoint(peerEndpointId) !== undefined;
  }

  /**
   * A rotated peer dials from an EndpointId nothing here recognises, so
   * admission is "I have someone to hear from at all", never "I know this
   * endpoint".
   */
  hasAnyLink(): boolean {
    return (
      this.gatewayDatabase.db
        .prepare(
          `SELECT 1 FROM vault_links vl
            JOIN vault_routes vr
              ON vr.vault_id IN (vl.vault_a, vl.vault_b)
            WHERE vl.revoked = 0
            LIMIT 1`
        )
        .get() !== undefined
    );
  }

  peerForVault(
    peerVaultId: string,
    localVaultId?: string
  ): LinkedPeer | undefined {
    for (const link of this.listFor(peerVaultId)) {
      if (link.revoked) continue;
      const mine = link.vaultA === peerVaultId ? link.vaultB : link.vaultA;
      if (localVaultId !== undefined && mine !== localVaultId) continue;
      const view = this.peerView(link, mine);
      if (view) return view;
    }
    return undefined;
  }

  peersOf(localVaultId: string): LinkedPeer[] {
    return this.listFor(localVaultId)
      .filter((link) => !link.revoked)
      .flatMap((link) => this.peerView(link, localVaultId) ?? []);
  }

  /**
   * Identity is deliberately NOT writable here: an assertion moves an address,
   * never a key. A vault with no route row is local and one with no live link
   * is nobody this gateway listens about, so both are refused (#750).
   */
  recordRoute(input: {
    peerVaultId: string;
    peerEndpointId: string;
    peerRelayHints: string[];
    assertedAt: number;
    signature?: string;
  }): boolean {
    return this.gatewayDatabase.transaction(() => {
      const current = this.routeFor(input.peerVaultId);
      if (!current) return false;
      const linked = this.listFor(input.peerVaultId).some(
        (link) => !link.revoked
      );
      if (!linked) return false;
      if (input.assertedAt <= current.assertedAt) return false;
      this.upsertRoute(input.peerVaultId, {
        endpointId: input.peerEndpointId,
        relayHints: input.peerRelayHints,
        assertedAt: input.assertedAt,
        ...(input.signature === undefined
          ? {}
          : { signature: input.signature }),
      });
      return true;
    });
  }

  revoke(linkId: string): boolean {
    const changed =
      this.gatewayDatabase.db
        .prepare("UPDATE vault_links SET revoked = 1 WHERE link_id = ?")
        .run(linkId).changes > 0;
    if (changed) this.announce(this.get(linkId), "revoked");
    return changed;
  }
}
