/*
 * Remote link ticket (#726 P3): secret returned once, sha256-only;
 * minting IS consent; claim = conditional DELETE in the SAME transaction
 * as the link write. Local pairs never touch this table.
 */

import crypto from "node:crypto";

import type { GatewayDatabase } from "./gateway-db.js";

export const DEFAULT_LINK_TICKET_TTL_MS = 15 * 60 * 1000;

export interface MintedLinkTicket {
  ticketId: string;
  secret: string;
  expiresAt: number;
}

export interface ClaimedLinkTicket {
  vaultId: string;
  vaultPublicKey: string;
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

  /** Peer ALPN admits an unknown endpoint ONLY while this is true or a link exists. */
  hasPending(now = Date.now()): boolean {
    return (
      this.gatewayDatabase.db
        .prepare("SELECT 1 FROM peer_link_tickets WHERE expires_at > ? LIMIT 1")
        .get(now) !== undefined
    );
  }

  /** Every failure is ONE outcome (`undefined`) — a presenter learns nothing. */
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
