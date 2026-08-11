/*
 * `vault_links` — the ONE table, and the one store, that answers "may an edge
 * cross between these two vaults" (issue #726 P2 §3 + P3 decisions 1–3).
 *
 * D3 makes locality ROUTING, not semantics: sharing to a vault means the same
 * thing whether that vault sits on this machine or across the world. So a
 * local pair and a remote pair are the same row shape — P1 gave EVERY vault
 * an Ed25519 identity keypair, so both sides carry a public key either way,
 * and the only thing remoteness adds is a replaceable route cache. "Is this
 * side remote" is "does this side need routing", and nothing else.
 *
 * A pair is always stored smaller-vault-id-first, so lookup is
 * order-independent and one pair can only ever have one row. Approval is the
 * ceremony in both localities: locally each owner's device approves its own
 * side; remotely minting the ticket is one side's approval and redeeming it
 * is the other's. An edge crosses only with BOTH sides approved.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";

import { GatewayDatabase } from "./gateway-db.js";
import { PeerLinkTicketStore } from "./peer-link-tickets.js";
import type {
  LinkedPeer,
  LinkRedemption,
  LinkRoute,
  PeerLinkInput,
  VaultLink,
  VaultLinkRow,
} from "./vault-link-row.js";
import {
  pairOf,
  peerViewOf,
  routeTo,
  sideOf,
  toLink,
} from "./vault-link-row.js";

function databaseFor(source: string | GatewayDatabase): GatewayDatabase {
  if (source instanceof GatewayDatabase) return source;
  return GatewayDatabase.open(path.dirname(path.resolve(source)));
}

export class VaultLinksStore {
  readonly gatewayDatabase: GatewayDatabase;
  readonly tickets: PeerLinkTicketStore;

  constructor(gatewayDatabase: GatewayDatabase) {
    this.gatewayDatabase = gatewayDatabase;
    this.tickets = new PeerLinkTicketStore(gatewayDatabase);
  }

  /** For hosts holding a data-dir path rather than an open handle. */
  static open(source: string | GatewayDatabase): VaultLinksStore {
    return new VaultLinksStore(databaseFor(source));
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

  /** The link between this exact pair, in either argument order. Named
   *  `findPair`, not `find` (oxlint's `unicorn/no-array-method-this-argument`
   *  pattern-matches any two-argument `.find(...)` call as Array.prototype's
   *  `(predicate, thisArg)` form, regardless of receiver type). */
  findPair(vaultX: string, vaultY: string): VaultLink | undefined {
    const [a, b] = pairOf(vaultX, vaultY);
    return this.row(
      "SELECT * FROM vault_links WHERE vault_a = ? AND vault_b = ?",
      a,
      b
    );
  }

  /** Every link naming this vault on either side. */
  listFor(vaultId: string): VaultLink[] {
    return this.rows(
      `SELECT * FROM vault_links
        WHERE vault_a = ? OR vault_b = ?
        ORDER BY created_at`,
      vaultId,
      vaultId
    );
  }

  /** Every link naming ANY vault this owner owns, on either side. */
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

  /**
   * Propose a link from a vault the caller owns to another vault ON THIS
   * GATEWAY. Idempotent: proposing the same pair again returns the existing
   * row untouched — the other owner's device approves separately, and
   * proposing never re-marks an approval.
   */
  propose(input: {
    fromVaultId: string;
    fromPublicKey: string;
    toVaultId: string;
    toPublicKey: string;
    fromPartyId?: string;
    toPartyId?: string;
    /**
     * Both vaults are on THIS gateway (unlike the remote ceremony's
     * self-declared label), so their display names are already known and
     * are recorded immediately — #726 P6 gap 3: a same-machine link must not
     * sit unlabeled forever the way it did before (`propose()` used to write
     * neither column at all).
     */
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
    // The proposer's own side is approved by definition — the caller is a
    // device whose owner owns it. The other side stays NULL until that
    // owner's device approves. Neither side carries a route: both vaults are
    // here.
    this.gatewayDatabase.run(
      `INSERT INTO vault_links (
         link_id, vault_a, vault_b, public_key_a, public_key_b,
         label_a, label_b, approved_by_a, approved_by_b, permissions_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      linkId,
      a,
      b,
      fromIsA ? input.fromPublicKey : input.toPublicKey,
      fromIsA ? input.toPublicKey : input.fromPublicKey,
      (fromIsA ? input.fromLabel : input.toLabel) ?? null,
      (fromIsA ? input.toLabel : input.fromLabel) ?? null,
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
  }

  /**
   * Approve `vaultId`'s side of `linkId`. Idempotent — approving twice keeps
   * the original timestamp. `undefined` when `vaultId` names neither side, so
   * the caller refuses `not_found` without leaking which side was wrong.
   */
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
    return this.get(linkId)!;
  }

  /**
   * Record the far side of a COMPLETED remote ceremony (P3 decision 3: links
   * are mutual and direction-free). Both approvals are stamped here because
   * the ceremony IS the mutual approval — one side minted the ticket, the
   * other redeemed it — and which side did which decides nothing.
   */
  recordPeer(
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
    const peerRoute = JSON.stringify(input.route);
    this.gatewayDatabase.run(
      `INSERT INTO vault_links (
         link_id, vault_a, vault_b, public_key_a, public_key_b,
         label_a, label_b, approved_by_a, approved_by_b,
         route_a_json, route_b_json, permissions_json, revoked, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT (vault_a, vault_b) DO UPDATE SET
         public_key_a = excluded.public_key_a,
         public_key_b = excluded.public_key_b,
         label_a = excluded.label_a,
         label_b = excluded.label_b,
         approved_by_a = excluded.approved_by_a,
         approved_by_b = excluded.approved_by_b,
         route_a_json = excluded.route_a_json,
         route_b_json = excluded.route_b_json,
         permissions_json = excluded.permissions_json,
         revoked = 0`,
      randomUUID(),
      a,
      b,
      localIsA ? input.localPublicKey : input.peerPublicKey,
      localIsA ? input.peerPublicKey : input.localPublicKey,
      localIsA ? input.localLabel : input.peerLabel,
      localIsA ? input.peerLabel : input.localLabel,
      localIsA ? localApproval : peerApproval,
      localIsA ? peerApproval : localApproval,
      localIsA ? null : peerRoute,
      localIsA ? peerRoute : null,
      JSON.stringify(input.permissions ?? {}),
      now
    );
    return this.peerForVault(input.peerVaultId, input.localVaultId);
  }

  /** Complete the explicit party identities exchanged by a remote ceremony
   * without reissuing approvals, changing routes, or treating vault keys as
   * party ids. Both gateway copies end with the same direction-free mapping. */
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
    return this.peerForVault(input.peerVaultId, input.localVaultId);
  }

  /**
   * Burn the ticket and write the link in ONE transaction, so a ticket can
   * never be redeemed twice — not by a racing second scanner, not by a replay
   * after a crash between the two writes. The redemption BINDS the link to
   * the first presenting endpoint and public key.
   */
  redeem(input: LinkRedemption): LinkedPeer | undefined {
    return this.gatewayDatabase.transaction(() => {
      const claimed = this.tickets.claim(input.ticketId, input.secret);
      if (!claimed) return undefined;
      return this.recordPeer(
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
        // Minting the ticket was this side's approval; redeeming it is the
        // far side's. Same two columns a local ceremony fills.
        { local: claimed.createdAt, peer: new Date().toISOString() }
      );
    });
  }

  /** The live link a proved EndpointId currently routes to. */
  linkForEndpoint(peerEndpointId: string): VaultLink | undefined {
    return this.row(
      `SELECT * FROM vault_links
        WHERE revoked = 0
          AND ? IN (
            json_extract(route_a_json, '$.endpointId'),
            json_extract(route_b_json, '$.endpointId'))
        LIMIT 1`,
      peerEndpointId
    );
  }

  /** The same link, seen from the local vault the routed side is linked to. */
  peerForEndpoint(peerEndpointId: string): LinkedPeer | undefined {
    const link = this.linkForEndpoint(peerEndpointId);
    if (!link) return undefined;
    const localVaultId =
      link.routeA?.endpointId === peerEndpointId ? link.vaultB : link.vaultA;
    return peerViewOf(link, localVaultId);
  }

  /**
   * The live link a proved EndpointId routes to, for a NAMED peer vault
   * (audit #726 finding 2). An iroh endpoint is per-GATEWAY, not per-vault
   * (D1 invariant 2: one `endpointSecretKey` per box) — two vaults co-hosted
   * on one remote gateway share an EndpointId, so `linkForEndpoint` alone
   * cannot tell which of them a request concerns. Every route that attributes
   * an edge to a counterparty MUST resolve through this method instead,
   * feeding it a vault id the request itself claims (never inferred from the
   * endpoint), so a wrong or stale claim resolves to nothing rather than to
   * the other co-hosted vault's link.
   */
  linkForPeer(
    peerEndpointId: string,
    peerVaultId: string
  ): VaultLink | undefined {
    return this.row(
      `SELECT * FROM vault_links
        WHERE revoked = 0
          AND ((vault_a = ? AND json_extract(route_a_json, '$.endpointId') = ?)
            OR (vault_b = ? AND json_extract(route_b_json, '$.endpointId') = ?))`,
      peerVaultId,
      peerEndpointId,
      peerVaultId,
      peerEndpointId
    );
  }

  /** The same link, seen from the local vault — the disambiguated counterpart
   *  to `peerForEndpoint` (see `linkForPeer`). */
  peerForEndpointAndVault(
    peerEndpointId: string,
    peerVaultId: string
  ): LinkedPeer | undefined {
    const link = this.linkForPeer(peerEndpointId, peerVaultId);
    if (!link) return undefined;
    const localVaultId =
      link.vaultA === peerVaultId ? link.vaultB : link.vaultA;
    return peerViewOf(link, localVaultId);
  }

  /** Admission predicate for the peer ALPN. Never a device question. Coarse
   *  by design (endpoint-only): admission only asks "is there anyone to hear
   *  from at all" — per-request attribution is `peerForEndpointAndVault`'s job. */
  isLinked(peerEndpointId: string): boolean {
    return this.linkForEndpoint(peerEndpointId) !== undefined;
  }

  /**
   * Does this gateway hold ANY live remote link?
   *
   * A rotated peer dials from an EndpointId nothing here recognises — that is
   * the case route re-assertion exists for — so admission cannot be "I already
   * know this endpoint". It is "I have someone to hear from at all": with no
   * links and no live ceremony the plane accepts nothing, and with either the
   * only two routes an unrecognised caller can reach are both gated on a
   * secret or a vault signature.
   */
  hasAnyLink(): boolean {
    return (
      this.gatewayDatabase.db
        .prepare(
          `SELECT 1 FROM vault_links
            WHERE revoked = 0
              AND (route_a_json IS NOT NULL OR route_b_json IS NOT NULL)
            LIMIT 1`
        )
        .get() !== undefined
    );
  }

  /** The live link to a vault elsewhere, seen from the local side. */
  peerForVault(
    peerVaultId: string,
    localVaultId?: string
  ): LinkedPeer | undefined {
    for (const link of this.listFor(peerVaultId)) {
      if (link.revoked) continue;
      const mine = link.vaultA === peerVaultId ? link.vaultB : link.vaultA;
      if (localVaultId !== undefined && mine !== localVaultId) continue;
      const view = peerViewOf(link, mine);
      if (view) return view;
    }
    return undefined;
  }

  /** Every live link from `localVaultId` to a vault elsewhere. */
  peersOf(localVaultId: string): LinkedPeer[] {
    return this.listFor(localVaultId)
      .filter((link) => !link.revoked)
      .flatMap((link) => peerViewOf(link, localVaultId) ?? []);
  }

  /**
   * Replace a peer's route cache after a signature-verified assertion, unless
   * an equal-or-newer one already won. Identity is deliberately NOT writable
   * here: an assertion moves an address, never a key. A vault whose side of
   * the link carries no route is a vault on this gateway — a route assertion
   * for it is refused rather than applied.
   */
  recordRoute(input: {
    peerVaultId: string;
    peerEndpointId: string;
    peerRelayHints: string[];
    assertedAt: number;
    signature?: string;
  }): boolean {
    return this.gatewayDatabase.transaction(() => {
      const link = this.listFor(input.peerVaultId).find(
        (candidate) =>
          !candidate.revoked &&
          routeTo(candidate, input.peerVaultId) !== undefined
      );
      if (!link) return false;
      const current = routeTo(link, input.peerVaultId)!;
      if (input.assertedAt <= current.assertedAt) return false;
      const side = sideOf(link, input.peerVaultId)!;
      this.gatewayDatabase.run(
        side === "a"
          ? "UPDATE vault_links SET route_a_json = ? WHERE link_id = ?"
          : "UPDATE vault_links SET route_b_json = ? WHERE link_id = ?",
        JSON.stringify({
          endpointId: input.peerEndpointId,
          relayHints: input.peerRelayHints,
          assertedAt: input.assertedAt,
          ...(input.signature === undefined
            ? {}
            : { signature: input.signature }),
        } satisfies LinkRoute),
        link.linkId
      );
      return true;
    });
  }

  /** Tombstone a link. The row stays so a revoked peer stays recognisable. */
  revoke(linkId: string): boolean {
    return (
      this.gatewayDatabase.db
        .prepare("UPDATE vault_links SET revoked = 1 WHERE link_id = ?")
        .run(linkId).changes > 0
    );
  }
}
