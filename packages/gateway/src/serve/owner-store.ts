/*
 * Owners — the principal layer (issue #726).
 *
 * An owner is a human on this gateway. Authorization is two questions,
 * neither a role: whose device is this (`enrollment-store.ts` binds proved
 * EndpointIds to owners), and does that owner own this vault (`vault_owners`,
 * one owner per vault — the PRIMARY KEY is the invariant). The label is
 * display only — every binding and attribution keys on `ownerId`, so renaming
 * a person can never fork their history or strand their access.
 *
 * Two removal verbs live at different layers on purpose: revoking a device is
 * `EnrollmentStore.revoke` (a tombstone on one binding), while removing a
 * person is `OwnerStore.remove` — refused while they still own vaults,
 * because deleting a person must never orphan a vault.
 */

import crypto from "node:crypto";
import path from "node:path";

import { GatewayDatabase } from "./gateway-db.js";
import { OwnerRemovalError } from "./owner-removal-error.js";

export { OwnerRemovalError } from "./owner-removal-error.js";

export interface Owner {
  ownerId: string;
  label: string;
  createdAt: string;
}

interface OwnerRow {
  owner_id: string;
  label: string;
  created_at: number;
}

function databaseFor(source: string | GatewayDatabase): GatewayDatabase {
  if (source instanceof GatewayDatabase) return source;
  return GatewayDatabase.open(path.dirname(path.resolve(source)));
}

function toOwner(row: OwnerRow): Owner {
  return {
    ownerId: row.owner_id,
    label: row.label,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class OwnerStore {
  readonly gatewayDatabase: GatewayDatabase;

  private constructor(gatewayDatabase: GatewayDatabase) {
    this.gatewayDatabase = gatewayDatabase;
  }

  static open(source: string | GatewayDatabase): OwnerStore {
    return new OwnerStore(databaseFor(source));
  }

  list(): Owner[] {
    return (
      this.gatewayDatabase.db
        .prepare(
          "SELECT owner_id, label, created_at FROM owners ORDER BY created_at, owner_id"
        )
        .all() as unknown as OwnerRow[]
    ).map(toOwner);
  }

  get(ownerId: string): Owner | undefined {
    const row = this.gatewayDatabase.db
      .prepare(
        "SELECT owner_id, label, created_at FROM owners WHERE owner_id = ?"
      )
      .get(ownerId) as OwnerRow | undefined;
    return row ? toOwner(row) : undefined;
  }

  /** Resolve a CLI/UI selector: an exact id first, then an exact label. */
  find(selector: string): Owner | undefined {
    return (
      this.get(selector) ??
      this.list().find((owner) => owner.label === selector)
    );
  }

  create(label: string): Owner {
    return this.gatewayDatabase.transaction(() =>
      this.createWithinTransaction(label)
    );
  }

  createWithinTransaction(label: string): Owner {
    const trimmed = label.trim();
    if (!trimmed) throw new Error("owner label must not be empty");
    const ownerId = crypto.randomUUID();
    this.gatewayDatabase.db
      .prepare(
        "INSERT INTO owners (owner_id, label, created_at) VALUES (?, ?, ?)"
      )
      .run(ownerId, trimmed, Date.now());
    const created = this.get(ownerId);
    if (!created)
      throw new Error("owner row vanished immediately after insert");
    return created;
  }

  rename(ownerId: string, label: string): Owner {
    const trimmed = label.trim();
    if (!trimmed) throw new Error("owner label must not be empty");
    const changed = this.gatewayDatabase.db
      .prepare("UPDATE owners SET label = ? WHERE owner_id = ?")
      .run(trimmed, ownerId);
    if (changed.changes !== 1) throw new Error(`no owner matches "${ownerId}"`);
    const renamed = this.get(ownerId);
    if (!renamed)
      throw new Error("owner row vanished immediately after rename");
    return renamed;
  }

  /** The one owner of a vault, or undefined for a vault nobody owns yet. */
  ownerOf(vaultId: string): string | undefined {
    const row = this.gatewayDatabase.db
      .prepare("SELECT owner_id FROM vault_owners WHERE vault_id = ?")
      .get(vaultId) as { owner_id: string } | undefined;
    return row?.owner_id;
  }

  /**
   * Author ownership. INSERT OR REPLACE is deliberate: a vault has exactly
   * one owner, so re-pointing replaces rather than accumulates. Callers own
   * the "may this ownership change" decision.
   */
  setOwner(vaultId: string, ownerId: string): void {
    this.gatewayDatabase.db
      .prepare(
        "INSERT OR REPLACE INTO vault_owners (vault_id, owner_id) VALUES (?, ?)"
      )
      .run(vaultId, ownerId);
  }

  vaultsOwnedBy(ownerId: string): string[] {
    return (
      this.gatewayDatabase.db
        .prepare(
          "SELECT vault_id FROM vault_owners WHERE owner_id = ? ORDER BY vault_id"
        )
        .all(ownerId) as Array<{ vault_id: string }>
    ).map((row) => row.vault_id);
  }

  /**
   * Remove a person: one transaction that drops their device bindings and
   * the owner row. Refused while they still own vaults — the ownership
   * analogue of the old last-admin guard, structural instead of counted.
   */
  remove(ownerId: string): { removedEndpointIds: string[] } {
    return this.gatewayDatabase.transaction(() => {
      const owned = this.vaultsOwnedBy(ownerId);
      if (owned.length > 0) throw new OwnerRemovalError(ownerId, owned);
      const endpointIds = (
        this.gatewayDatabase.db
          .prepare("SELECT endpoint_id FROM devices WHERE owner_id = ?")
          .all(ownerId) as Array<{ endpoint_id: string }>
      ).map((row) => row.endpoint_id);
      this.gatewayDatabase.db
        .prepare(
          "DELETE FROM device_checkpoints WHERE endpoint_id IN (SELECT endpoint_id FROM devices WHERE owner_id = ?)"
        )
        .run(ownerId);
      this.gatewayDatabase.db
        .prepare("DELETE FROM devices WHERE owner_id = ?")
        .run(ownerId);
      const deleted = this.gatewayDatabase.db
        .prepare("DELETE FROM owners WHERE owner_id = ?")
        .run(ownerId);
      if (deleted.changes !== 1)
        throw new Error(`no owner matches "${ownerId}"`);
      return { removedEndpointIds: endpointIds };
    });
  }

  /** Drop ownership of an erased vault; owners and devices survive. */
  removeVault(vaultId: string): void {
    this.gatewayDatabase.db
      .prepare("DELETE FROM vault_owners WHERE vault_id = ?")
      .run(vaultId);
  }
}
