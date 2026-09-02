/*
 * Broker credential health (#351 tier 2): broker-carried connections needing
 * re-auth plus oauth2 tokens past expiry — refresh is LAZY (next fire), so
 * the grace window ignores momentary pre-refresh staleness.
 */

import type { DatabaseSync } from "node:sqlite";

import type { HealthProbe } from "./health-registry.js";

export interface BrokerHealthVaultEntry {
  readonly vaultId: string;
  readonly db: DatabaseSync;
}

export interface BrokerHealthOptions {
  readonly vaults: () => readonly BrokerHealthVaultEntry[];
  readonly overdueGraceMs?: number;
  readonly now?: () => number;
}

interface BrokerCredRow {
  connection_id: string;
  label: string;
  status: string;
  cred_kind: "oauth2" | "api_key";
  token_expires_at: string | null;
  auth_note: string | null;
}

const DEFAULT_OVERDUE_GRACE_MS = 60 * 60 * 1000;

export function createBrokerHealthProbe(
  options: BrokerHealthOptions
): HealthProbe {
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
               LEFT JOIN sync_connection_health h ON h.connection_id = cc.connection_id`
          )
          .all() as unknown as BrokerCredRow[];
      } catch {
        // Fresh/unmounted vault: no sync tables yet; the vaults probe flags mounts.
        continue;
      }
      for (const row of rows) {
        const tag = `${vault.vaultId.slice(0, 8)}/${row.label}`;
        if (row.status === "needs-auth") {
          needsAuth.push(row.auth_note ? `${tag} (${row.auth_note})` : tag);
          continue;
        }
        if (row.cred_kind === "oauth2" && row.token_expires_at) {
          const expiresAtMs = Date.parse(row.token_expires_at);
          if (
            Number.isFinite(expiresAtMs) &&
            now() - expiresAtMs > overdueGraceMs
          ) {
            overdue.push(tag);
          }
        }
      }
    }

    if (needsAuth.length === 0 && overdue.length === 0) {
      return { status: "ok", detail: "broker-carried connections healthy" };
    }
    const parts: string[] = [];
    if (needsAuth.length > 0) {
      parts.push(`${needsAuth.length} need re-auth: ${needsAuth.join(", ")}`);
    }
    if (overdue.length > 0) {
      parts.push(
        `${overdue.length} token refresh overdue: ${overdue.join(", ")}`
      );
    }
    return { status: "degraded", detail: parts.join("; ") };
  };
}
