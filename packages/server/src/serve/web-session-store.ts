/*
 * Durable PWA control sessions (issue #555).
 *
 * Cookie hashes live in gateway.db and join device enrollments with
 * ON DELETE CASCADE. A source-less store remains in-memory for isolated tests.
 */

import crypto from "node:crypto";
import path from "node:path";
import type { StatementSync } from "node:sqlite";

import { GatewayDatabase } from "./gateway-db.js";

export const CONTROL_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CONTROL_ABSOLUTE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const TOUCH_THROTTLE_MS = 60 * 60 * 1000;

export interface ControlSessionRow {
  tokenHash: string;
  vaultId: string;
  deviceKey?: string;
  shellOrigin: string;
  createdAt: string;
  expiresAt: number;
  lastUsedAt: number;
}

interface StoredSessionRow {
  token_hash: string;
  vault_id: string;
  device_key: string | null;
  shell_origin: string;
  created_at: string;
  expires_at: number;
  last_used_at: number;
}

export function hashControlToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function toSession(row: StoredSessionRow): ControlSessionRow {
  return {
    tokenHash: row.token_hash,
    vaultId: row.vault_id,
    ...(row.device_key ? { deviceKey: row.device_key } : {}),
    shellOrigin: row.shell_origin,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * SQL prepared once per store (issue #659 G3). `GatewayDatabase.db` is a
 * `readonly` handle for the process lifetime, so a statement compiled here
 * stays valid; re-preparing on every authorize() re-parsed six statements per
 * HTTP request.
 */
interface SessionStatements {
  establish: StatementSync;
  findOne: StatementSync;
  touch: StatementSync;
  remove: StatementSync;
  sweep: StatementSync;
  list: StatementSync;
}

const SELECT_COLUMNS =
  "token_hash, vault_id, device_key, shell_origin, created_at, expires_at, last_used_at";

export class WebControlSessionStore {
  private readonly memory: ControlSessionRow[] | undefined;
  private readonly gatewayDatabase: GatewayDatabase | undefined;
  private prepared: SessionStatements | undefined;

  private constructor(
    gatewayDatabase: GatewayDatabase | undefined,
    private readonly now: () => number
  ) {
    this.gatewayDatabase = gatewayDatabase;
    this.memory = gatewayDatabase ? undefined : [];
  }

  private statements(database: GatewayDatabase): SessionStatements {
    if (this.prepared) return this.prepared;
    const { db } = database;
    this.prepared = {
      establish: db.prepare(
        `INSERT INTO web_sessions (
            token_hash, vault_id, device_key, shell_origin, created_at, expires_at, last_used_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(token_hash) DO UPDATE SET
            vault_id = excluded.vault_id,
            device_key = excluded.device_key,
            shell_origin = excluded.shell_origin,
            created_at = excluded.created_at,
            expires_at = excluded.expires_at,
            last_used_at = excluded.last_used_at`
      ),
      findOne: db.prepare(
        `SELECT ${SELECT_COLUMNS} FROM web_sessions
           WHERE token_hash = ? AND expires_at > ?`
      ),
      touch: db.prepare(
        "UPDATE web_sessions SET expires_at = ?, last_used_at = ? WHERE token_hash = ?"
      ),
      remove: db.prepare("DELETE FROM web_sessions WHERE token_hash = ?"),
      sweep: db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?"),
      list: db.prepare(
        `SELECT ${SELECT_COLUMNS} FROM web_sessions WHERE expires_at > ? ORDER BY created_at`
      ),
    };
    return this.prepared;
  }

  static open(
    source?: string | GatewayDatabase,
    now: () => number = Date.now
  ): WebControlSessionStore {
    const gatewayDatabase =
      source instanceof GatewayDatabase
        ? source
        : typeof source === "string"
          ? GatewayDatabase.open(path.dirname(path.resolve(source)))
          : undefined;
    const store = new WebControlSessionStore(gatewayDatabase, now);
    store.sweepExpired();
    return store;
  }

  establish(input: {
    tokenHash: string;
    vaultId: string;
    deviceKey?: string;
    shellOrigin: string;
  }): ControlSessionRow {
    const now = this.now();
    const row: ControlSessionRow = {
      tokenHash: input.tokenHash,
      vaultId: input.vaultId,
      ...(input.deviceKey ? { deviceKey: input.deviceKey } : {}),
      shellOrigin: input.shellOrigin,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + CONTROL_IDLE_TTL_MS,
      lastUsedAt: now,
    };
    if (this.gatewayDatabase) {
      this.statements(this.gatewayDatabase).establish.run(
        row.tokenHash,
        row.vaultId,
        row.deviceKey ?? null,
        row.shellOrigin,
        row.createdAt,
        row.expiresAt,
        row.lastUsedAt
      );
    } else {
      const existing = this.memory!.findIndex(
        (candidate) => candidate.tokenHash === row.tokenHash
      );
      if (existing >= 0) this.memory!.splice(existing, 1);
      this.memory!.push(row);
    }
    return row;
  }

  /**
   * Look a live session up by its cookie hash.
   *
   * The row is fetched by PRIMARY KEY rather than by scanning every live
   * session (issue #659 G3): the scan was O(sessions) SQL on every authorized
   * request. The constant-time comparison is kept on the returned row, and the
   * value being matched is already a SHA-256 of the cookie — `touch()` and
   * `remove()` have always looked it up by key, so the index lookup exposes
   * nothing new. Expired rows never match, so authorization does not depend on
   * the sweep having run.
   */
  find(tokenHash: string): ControlSessionRow | undefined {
    const expected = Buffer.from(tokenHash, "hex");
    const candidates = this.gatewayDatabase
      ? (
          this.statements(this.gatewayDatabase).findOne.all(
            tokenHash,
            this.now()
          ) as unknown as StoredSessionRow[]
        ).map(toSession)
      : this.list();
    for (const row of candidates) {
      const actual = Buffer.from(row.tokenHash, "hex");
      if (
        expected.length === actual.length &&
        crypto.timingSafeEqual(expected, actual)
      )
        return row;
    }
    return undefined;
  }

  touch(tokenHash: string): void {
    const row = this.find(tokenHash);
    if (!row) return;
    const now = this.now();
    // The absolute TTL is enforced HERE, from the stored creation instant
    // (issue #865): the cookie Max-Age is advisory — a stolen cookie file
    // replays without any browser honoring it. The idle window can slide a
    // session's expiry, but never past its creation + CONTROL_ABSOLUTE_TTL_MS.
    const created = Date.parse(row.createdAt);
    // A malformed createdAt (Date.parse → NaN) would otherwise write NaN
    // into expires_at: Math.min(idle, NaN) is NaN, and NaN <= now is false.
    if (Number.isNaN(created)) {
      this.remove(tokenHash);
      return;
    }
    const absolute = created + CONTROL_ABSOLUTE_TTL_MS;
    const nextExpiry = Math.min(now + CONTROL_IDLE_TTL_MS, absolute);
    // A row already past its absolute lifetime (e.g. written by an older
    // build without the cap) dies on first touch instead of sliding.
    if (nextExpiry <= now) {
      this.remove(tokenHash);
      return;
    }
    if (nextExpiry - row.expiresAt < TOUCH_THROTTLE_MS) return;
    if (this.gatewayDatabase) {
      this.statements(this.gatewayDatabase).touch.run(
        nextExpiry,
        now,
        tokenHash
      );
    } else {
      row.expiresAt = nextExpiry;
      row.lastUsedAt = now;
    }
  }

  remove(tokenHash: string): boolean {
    if (this.gatewayDatabase) {
      return (
        this.statements(this.gatewayDatabase).remove.run(tokenHash).changes > 0
      );
    }
    const index = this.memory!.findIndex((row) => row.tokenHash === tokenHash);
    if (index < 0) return false;
    this.memory!.splice(index, 1);
    return true;
  }

  sweepExpired(): void {
    const now = this.now();
    if (this.gatewayDatabase) {
      this.statements(this.gatewayDatabase).sweep.run(now);
      return;
    }
    for (let index = this.memory!.length - 1; index >= 0; index--) {
      if (this.memory![index]!.expiresAt <= now) this.memory!.splice(index, 1);
    }
  }

  list(): ControlSessionRow[] {
    const now = this.now();
    if (!this.gatewayDatabase) {
      return this.memory!.filter((row) => row.expiresAt > now).map((row) => ({
        ...row,
      }));
    }
    return (
      this.statements(this.gatewayDatabase).list.all(
        now
      ) as unknown as StoredSessionRow[]
    ).map(toSession);
  }
}
