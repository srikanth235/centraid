import type { GatewayDatabase } from "./gateway-db.js";
import type { LinkRoute } from "./vault-link-row.js";

export type VaultLocality = "local" | "peer";

export interface VaultDirectoryEntry {
  vaultId: string;
  publicKey: string;
  label: string | null;
  locality: VaultLocality;
  route?: LinkRoute;
}

interface DirectoryRow {
  vault_id: string;
  public_key: string;
  label: string | null;
  locality: VaultLocality;
  endpoint_id: string | null;
  relay_hints_json: string | null;
  asserted_at: number | null;
  signature: string | null;
}

function identityMismatch(vaultId: string): Error {
  return Object.assign(
    new Error(`vault ${vaultId} does not match its stable identity directory`),
    { name: "VaultIdentityMismatchError", code: "vault_identity_mismatch" }
  );
}

/**
 * One stable identity and one current route per vault. Links, Commons grants,
 * and edges name the vault id and resolve through this directory instead of
 * copying keys, labels, and addresses into relationship rows (#750).
 */
export class VaultDirectory {
  constructor(private readonly gatewayDatabase: GatewayDatabase) {}

  get(vaultId: string): VaultDirectoryEntry | undefined {
    const row = this.gatewayDatabase.db
      .prepare(
        `SELECT d.*, r.endpoint_id, r.relay_hints_json, r.asserted_at, r.signature
           FROM vault_directory d
           LEFT JOIN vault_routes r ON r.vault_id = d.vault_id
          WHERE d.vault_id = ?`
      )
      .get(vaultId) as DirectoryRow | undefined;
    return row ? toEntry(row) : undefined;
  }

  list(): VaultDirectoryEntry[] {
    return (
      this.gatewayDatabase.db
        .prepare(
          `SELECT d.*, r.endpoint_id, r.relay_hints_json, r.asserted_at, r.signature
             FROM vault_directory d
             LEFT JOIN vault_routes r ON r.vault_id = d.vault_id
            ORDER BY d.created_at, d.vault_id`
        )
        .all() as unknown as DirectoryRow[]
    ).map(toEntry);
  }

  recordLocal(input: {
    vaultId: string;
    publicKey: string;
    label: string | null;
    now?: () => number;
  }): VaultDirectoryEntry {
    const entry = this.record({ ...input, locality: "local" });
    this.gatewayDatabase.run(
      "DELETE FROM vault_routes WHERE vault_id = ?",
      input.vaultId
    );
    return { ...entry, route: undefined };
  }

  recordPeer(input: {
    vaultId: string;
    publicKey: string;
    label: string | null;
    route: LinkRoute;
    now?: () => number;
  }): VaultDirectoryEntry {
    const entry = this.record({ ...input, locality: "peer" });
    this.recordRoute({
      vaultId: input.vaultId,
      route: input.route,
      allowEqual: true,
      ...(input.now ? { now: input.now } : {}),
    });
    return this.get(entry.vaultId)!;
  }

  recordRoute(input: {
    vaultId: string;
    route: LinkRoute;
    allowEqual?: boolean;
    now?: () => number;
  }): boolean {
    const entry = this.get(input.vaultId);
    if (!entry || entry.locality !== "peer") return false;
    if (
      entry.route &&
      (input.allowEqual
        ? input.route.assertedAt < entry.route.assertedAt
        : input.route.assertedAt <= entry.route.assertedAt)
    ) {
      return false;
    }
    const updatedAt = new Date((input.now ?? Date.now)()).toISOString();
    this.gatewayDatabase.run(
      `INSERT INTO vault_routes (
         vault_id, endpoint_id, relay_hints_json, asserted_at, signature, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (vault_id) DO UPDATE SET
         endpoint_id = excluded.endpoint_id,
         relay_hints_json = excluded.relay_hints_json,
         asserted_at = excluded.asserted_at,
         signature = excluded.signature,
         updated_at = excluded.updated_at`,
      input.vaultId,
      input.route.endpointId,
      JSON.stringify(input.route.relayHints),
      input.route.assertedAt,
      input.route.signature ?? null,
      updatedAt
    );
    return true;
  }

  private record(input: {
    vaultId: string;
    publicKey: string;
    label: string | null;
    locality: VaultLocality;
    now?: () => number;
  }): VaultDirectoryEntry {
    const existing = this.get(input.vaultId);
    if (existing && existing.publicKey !== input.publicKey) {
      throw identityMismatch(input.vaultId);
    }
    const now = new Date((input.now ?? Date.now)()).toISOString();
    this.gatewayDatabase.run(
      `INSERT INTO vault_directory (
         vault_id, public_key, label, locality, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (vault_id) DO UPDATE SET
         label = excluded.label,
         locality = excluded.locality,
         updated_at = excluded.updated_at`,
      input.vaultId,
      input.publicKey,
      input.label,
      input.locality,
      now,
      now
    );
    return this.get(input.vaultId)!;
  }
}

function toEntry(row: DirectoryRow): VaultDirectoryEntry {
  const route =
    row.endpoint_id === null ||
    row.relay_hints_json === null ||
    row.asserted_at === null
      ? undefined
      : {
          endpointId: row.endpoint_id,
          relayHints: JSON.parse(row.relay_hints_json) as string[],
          assertedAt: row.asserted_at,
          ...(row.signature === null ? {} : { signature: row.signature }),
        };
  return {
    vaultId: row.vault_id,
    publicKey: row.public_key,
    label: row.label,
    locality: row.locality,
    ...(route ? { route } : {}),
  };
}
