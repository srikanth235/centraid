import crypto from "node:crypto";
import type { StatementSync } from "node:sqlite";

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
  private sweepStatement: StatementSync | undefined;

  constructor(private readonly gatewayDatabase: GatewayDatabase) {}

  sweepExpired(now = Date.now()): number {
    this.sweepStatement ??= this.gatewayDatabase.db.prepare(
      "DELETE FROM peer_link_tickets WHERE expires_at <= ?"
    );
    return Number(this.sweepStatement.run(now).changes);
  }

  mint(
    vaultId: string,
    vaultPublicKey: string,
    ttlMs = DEFAULT_LINK_TICKET_TTL_MS
  ): MintedLinkTicket {
    this.sweepExpired();
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

  hasPending(now = Date.now()): boolean {
    this.sweepExpired();
    return (
      this.gatewayDatabase.db
        .prepare("SELECT 1 FROM peer_link_tickets WHERE expires_at > ? LIMIT 1")
        .get(now) !== undefined
    );
  }

  claim(ticketId: string, secret: string): ClaimedLinkTicket | undefined {
    this.sweepExpired();
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
