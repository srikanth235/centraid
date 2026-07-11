/*
 * Connection-broker credential health — the `broker` component (issue #351
 * tier 2).
 *
 * The `connections` component (`build-gateway.ts`) already counts every
 * connection's `needs-auth` status across ALL connections, harness-ambient
 * included. This probe is narrower and specifically about the BROKER's own
 * custody of `sync_connection_credential` rows (issue #304's oauth2/api_key
 * sidecar): it names WHICH broker-carried connections are dead
 * (`needs-auth`, with the broker's own `sync_connection_health.auth_note`
 * reason) and — the signal `connections` can't give you — which oauth2
 * credentials are sitting past their `token_expires_at` without having been
 * flipped yet. That second case is real: `ConnectionBroker.ensureFreshToken`
 * only refreshes LAZILY, on the next fire that needs the connection: an
 * automation that hasn't fired since expiry leaves a stale-but-not-yet-
 * diagnosed token sitting there. A grace window (past expiry, not "about
 * to" expire) keeps this from flagging the normal one-tick staleness every
 * token has moments before its next lazy refresh.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { HealthProbe } from './health-registry.js';

export interface BrokerHealthVaultEntry {
  readonly vaultId: string;
  /** The vault's `vault.db` handle — `sync_connection*` tables live here. */
  readonly db: DatabaseSync;
}

export interface BrokerHealthOptions {
  readonly vaults: () => readonly BrokerHealthVaultEntry[];
  /** How far past `token_expires_at` before it counts as "overdue" rather than momentarily stale. Defaults to 1h. */
  readonly overdueGraceMs?: number;
  /** Clock override (tests). */
  readonly now?: () => number;
}

interface BrokerCredRow {
  connection_id: string;
  label: string;
  status: string;
  cred_kind: 'oauth2' | 'api_key';
  token_expires_at: string | null;
  auth_note: string | null;
}

const DEFAULT_OVERDUE_GRACE_MS = 60 * 60 * 1000;

/** Builds the `broker` component's `HealthProbe` (registered in `build-gateway.ts`). */
export function createBrokerHealthProbe(options: BrokerHealthOptions): HealthProbe {
  const now = options.now ?? Date.now;
  const overdueGraceMs = options.overdueGraceMs ?? DEFAULT_OVERDUE_GRACE_MS;

  return async () => {
    const needsAuth: string[] = [];
    const overdue: string[] = [];

    for (const vault of options.vaults()) {
      let rows: BrokerCredRow[];
      try {
        rows = vault.db
          .prepare(
            `SELECT c.connection_id, c.label, c.status, cc.cred_kind, cc.token_expires_at, h.auth_note
               FROM sync_connection_credential cc
               JOIN sync_connection c ON c.connection_id = cc.connection_id
               LEFT JOIN sync_connection_health h ON h.connection_id = cc.connection_id`,
          )
          .all() as unknown as BrokerCredRow[];
      } catch {
        // A vault whose plane failed to mount / has no sync tables yet
        // (fresh vault) contributes nothing — the `vaults` probe already
        // flags a failed mount.
        continue;
      }
      for (const row of rows) {
        const tag = `${vault.vaultId.slice(0, 8)}/${row.label}`;
        if (row.status === 'needs-auth') {
          needsAuth.push(row.auth_note ? `${tag} (${row.auth_note})` : tag);
          continue;
        }
        if (row.cred_kind === 'oauth2' && row.token_expires_at) {
          const expiresAtMs = Date.parse(row.token_expires_at);
          if (Number.isFinite(expiresAtMs) && now() - expiresAtMs > overdueGraceMs) {
            overdue.push(tag);
          }
        }
      }
    }

    if (needsAuth.length === 0 && overdue.length === 0) {
      return { status: 'ok', detail: 'broker-carried connections healthy' };
    }
    const parts: string[] = [];
    if (needsAuth.length > 0) {
      parts.push(`${needsAuth.length} need re-auth: ${needsAuth.join(', ')}`);
    }
    if (overdue.length > 0) {
      parts.push(`${overdue.length} token refresh overdue: ${overdue.join(', ')}`);
    }
    return { status: 'degraded', detail: parts.join('; ') };
  };
}
