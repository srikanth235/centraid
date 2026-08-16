/*
 * `peer_link_tickets` — the one-time capability the REMOTE half of the link
 * ceremony runs on (issue #726 P3 decision 3).
 *
 * A ticket is short-lived by design: a ceremony is a live moment, not a
 * standing invitation. The secret is returned once and stored only as a
 * sha256, so a stolen gateway.db yields nothing redeemable. Claiming is a
 * conditional DELETE — the affected row count, not an in-process mutex, is
 * the single-use authority — and the caller runs it inside the SAME
 * transaction that writes the link, so a crash between the two cannot leave a
 * burned ticket with no link or a link with a live ticket.
 *
 * Local pairs (both vaults on this gateway) never touch this table: their
 * ceremony is two owners' devices approving, with no secret to carry.
 */

import crypto from "node:crypto";

import type { GatewayDatabase } from "./gateway-db.js";

/** A ceremony is a live moment. */
export const DEFAULT_LINK_TICKET_TTL_MS = 15 * 60 * 1000;

export interface MintedLinkTicket {
  ticketId: string;
  /** Returned ONCE — never recoverable from the row. */
  secret: string;
  expiresAt: number;
}

export interface ClaimedLinkTicket {
  vaultId: string;
  /** The identity key the ticket promised, which the link then records. */
  vaultPublicKey: string;
  /** Minting IS this side's approval of the link (P3 decision 3). */
  createdAt: string;
}

function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

export class PeerLinkTicketStore {
  constructor(private readonly gatewayDatabase: GatewayDatabase) {}

  mint(
    vaultId: string,
    vaultPublicKey: string,
    ttlMs = DEFAULT_LINK_TICKET_TTL_MS
  ): MintedLinkTicket {
    const ticketId = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + ttlMs;
    this.gatewayDatabase.db
      .prepare(
        `INSERT INTO peer_link_tickets
           (ticket_id, secret_hash, vault_id, vault_public_key, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        ticketId,
        hashSecret(secret),
        vaultId,
        vaultPublicKey,
        new Date().toISOString(),
        expiresAt
      );
    return { ticketId, secret, expiresAt };
  }

  /**
   * Is a ceremony live right now? The peer ALPN admits an unknown endpoint
   * ONLY while this is true or a link already exists, so the plane has no
   * permanently open door.
   */
  hasPending(now = Date.now()): boolean {
    return (
      this.gatewayDatabase.db
        .prepare("SELECT 1 FROM peer_link_tickets WHERE expires_at > ? LIMIT 1")
        .get(now) !== undefined
    );
  }

  /**
   * Burn `ticketId` if `secret` matches and it has not expired. Unknown,
   * expired, wrong-secret, and already-burned are ONE outcome — `undefined` —
   * so a presenter learns nothing about tickets it does not hold.
   */
  claim(ticketId: string, secret: string): ClaimedLinkTicket | undefined {
    const row = this.gatewayDatabase.db
      .prepare(
        `SELECT secret_hash, vault_id, vault_public_key, created_at, expires_at
           FROM peer_link_tickets WHERE ticket_id = ?`
      )
      .get(ticketId) as
      | {
          secret_hash: string;
          vault_id: string;
          vault_public_key: string;
          created_at: string;
          expires_at: number;
        }
      | undefined;
    if (!row || row.expires_at <= Date.now()) return undefined;
    const expected = Buffer.from(row.secret_hash, "hex");
    const actual = Buffer.from(hashSecret(secret), "hex");
    if (
      expected.length !== actual.length ||
      !crypto.timingSafeEqual(expected, actual)
    ) {
      return undefined;
    }
    const burned = this.gatewayDatabase.db
      .prepare("DELETE FROM peer_link_tickets WHERE ticket_id = ?")
      .run(ticketId);
    if (burned.changes !== 1) return undefined;
    return {
      vaultId: row.vault_id,
      vaultPublicKey: row.vault_public_key,
      createdAt: row.created_at,
    };
  }
}
