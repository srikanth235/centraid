import type { GatewayDatabase } from "./gateway-db.js";
import type { LinkRoute, VaultDirectoryEntry } from "./vault-link-row.js";
import { VaultDirectoryIdentityError } from "./vault-link-row.js";

interface VaultRouteRow {
  vault_id: string;
  endpoint_id: string;
  relay_hints_json: string;
  asserted_at: number;
  signature: string | null;
}

interface VaultDirectoryRow {
  vault_id: string;
  public_key: string;
  label: string | null;
  created_at: string;
}

function toRoute(row: VaultRouteRow): LinkRoute {
  const hints = JSON.parse(row.relay_hints_json) as unknown;
  return {
    endpointId: row.endpoint_id,
    relayHints: Array.isArray(hints)
      ? hints.filter((hint): hint is string => typeof hint === "string")
      : [],
    assertedAt: row.asserted_at,
    ...(row.signature === null ? {} : { signature: row.signature }),
  };
}

export function directoryEntryOf(
  gatewayDatabase: GatewayDatabase,
  vaultId: string
): VaultDirectoryEntry | undefined {
  const row = gatewayDatabase.db
    .prepare("SELECT * FROM vault_directory WHERE vault_id = ?")
    .get(vaultId) as unknown as VaultDirectoryRow | undefined;
  if (!row) return undefined;
  return {
    vaultId: row.vault_id,
    publicKey: row.public_key,
    label: row.label,
    createdAt: row.created_at,
  };
}

export function routeOf(
  gatewayDatabase: GatewayDatabase,
  vaultId: string
): LinkRoute | undefined {
  const row = gatewayDatabase.db
    .prepare("SELECT * FROM vault_routes WHERE vault_id = ?")
    .get(vaultId) as unknown as VaultRouteRow | undefined;
  return row ? toRoute(row) : undefined;
}

export function upsertDirectoryRow(
  gatewayDatabase: GatewayDatabase,
  vaultId: string,
  publicKey: string,
  label: string | null,
  createdAt: string
): void {
  const known = directoryEntryOf(gatewayDatabase, vaultId);
  if (known && known.publicKey !== publicKey) {
    throw new VaultDirectoryIdentityError(vaultId);
  }
  gatewayDatabase.run(
    `INSERT INTO vault_directory (vault_id, public_key, label, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (vault_id) DO UPDATE SET
       label = COALESCE(excluded.label, vault_directory.label)`,
    vaultId,
    publicKey,
    label,
    createdAt
  );
}

export function upsertRouteRow(
  gatewayDatabase: GatewayDatabase,
  vaultId: string,
  route: LinkRoute
): void {
  gatewayDatabase.run(
    `INSERT INTO vault_routes
       (vault_id, endpoint_id, relay_hints_json, asserted_at, signature)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (vault_id) DO UPDATE SET
       endpoint_id = excluded.endpoint_id,
       relay_hints_json = excluded.relay_hints_json,
       asserted_at = excluded.asserted_at,
       signature = excluded.signature`,
    vaultId,
    route.endpointId,
    JSON.stringify(route.relayHints),
    route.assertedAt,
    route.signature ?? null
  );
}
