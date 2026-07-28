/*
 * Durable PWA control sessions (issue #555).
 *
 * Cookie hashes live in gateway.db and join device enrollments with
 * ON DELETE CASCADE. A source-less store remains in-memory for isolated tests.
 */

import crypto from 'node:crypto';
import path from 'node:path';

import { GatewayDatabase } from './gateway-db.js';

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
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
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

export class WebControlSessionStore {
  private readonly memory: ControlSessionRow[] | undefined;
  private readonly gatewayDatabase: GatewayDatabase | undefined;

  private constructor(
    gatewayDatabase: GatewayDatabase | undefined,
    private readonly now: () => number,
  ) {
    this.gatewayDatabase = gatewayDatabase;
    this.memory = gatewayDatabase ? undefined : [];
  }

  static open(
    source?: string | GatewayDatabase,
    now: () => number = Date.now,
  ): WebControlSessionStore {
    const gatewayDatabase =
      source instanceof GatewayDatabase
        ? source
        : typeof source === 'string'
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
      this.gatewayDatabase.db
        .prepare(
          `INSERT INTO web_sessions (
            token_hash, vault_id, device_key, shell_origin, created_at, expires_at, last_used_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(token_hash) DO UPDATE SET
            vault_id = excluded.vault_id,
            device_key = excluded.device_key,
            shell_origin = excluded.shell_origin,
            created_at = excluded.created_at,
            expires_at = excluded.expires_at,
            last_used_at = excluded.last_used_at`,
        )
        .run(
          row.tokenHash,
          row.vaultId,
          row.deviceKey ?? null,
          row.shellOrigin,
          row.createdAt,
          row.expiresAt,
          row.lastUsedAt,
        );
    } else {
      const existing = this.memory!.findIndex((candidate) => candidate.tokenHash === row.tokenHash);
      if (existing >= 0) this.memory!.splice(existing, 1);
      this.memory!.push(row);
    }
    return row;
  }

  find(tokenHash: string): ControlSessionRow | undefined {
    const expected = Buffer.from(tokenHash, 'hex');
    for (const row of this.list()) {
      const actual = Buffer.from(row.tokenHash, 'hex');
      if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) return row;
    }
    return undefined;
  }

  touch(tokenHash: string): void {
    const row = this.find(tokenHash);
    if (!row) return;
    const now = this.now();
    const nextExpiry = now + CONTROL_IDLE_TTL_MS;
    if (nextExpiry - row.expiresAt < TOUCH_THROTTLE_MS) return;
    if (this.gatewayDatabase) {
      this.gatewayDatabase.db
        .prepare('UPDATE web_sessions SET expires_at = ?, last_used_at = ? WHERE token_hash = ?')
        .run(nextExpiry, now, tokenHash);
    } else {
      row.expiresAt = nextExpiry;
      row.lastUsedAt = now;
    }
  }

  remove(tokenHash: string): boolean {
    if (this.gatewayDatabase) {
      return (
        this.gatewayDatabase.db
          .prepare('DELETE FROM web_sessions WHERE token_hash = ?')
          .run(tokenHash).changes > 0
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
      this.gatewayDatabase.db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(now);
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
      this.gatewayDatabase.db
        .prepare(
          `SELECT token_hash, vault_id, device_key, shell_origin, created_at, expires_at, last_used_at
             FROM web_sessions WHERE expires_at > ? ORDER BY created_at`,
        )
        .all(now) as unknown as StoredSessionRow[]
    ).map(toSession);
  }
}
