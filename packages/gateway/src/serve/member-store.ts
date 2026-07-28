/*
 * Household members — the L2 principal layer (issue #599).
 *
 * A member is a human on this gateway. Authority is authored on
 * `(member, vault)` and nowhere else; devices are bindings that inherit it
 * (`enrollment-store.ts`). The label is display only — every binding, every
 * grant, and every attribution keys on `memberId`, so renaming a person can
 * never fork their history or strand their access.
 *
 * Two removal verbs live at different layers on purpose: revoking a device is
 * `EnrollmentStore.revoke` (a tombstone on one binding), while removing a
 * person is `MemberStore.remove` — one transaction that drops their grants
 * and every binding they own.
 */

import crypto from "node:crypto";
import path from "node:path";

import type { GrantableRole } from "./enrollment-store.js";
import { GatewayDatabase } from "./gateway-db.js";

export interface Member {
  memberId: string;
  label: string;
  createdAt: string;
}

/** One authored authority fact: this member holds this role in this vault. */
export interface MemberGrant {
  vaultId: string;
  role: GrantableRole;
}

interface MemberRow {
  member_id: string;
  label: string;
  created_at: number;
}

function databaseFor(source: string | GatewayDatabase): GatewayDatabase {
  if (source instanceof GatewayDatabase) return source;
  return GatewayDatabase.open(path.dirname(path.resolve(source)));
}

function toMember(row: MemberRow): Member {
  return {
    memberId: row.member_id,
    label: row.label,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class MemberStore {
  readonly gatewayDatabase: GatewayDatabase;

  private constructor(gatewayDatabase: GatewayDatabase) {
    this.gatewayDatabase = gatewayDatabase;
  }

  static open(source: string | GatewayDatabase): MemberStore {
    return new MemberStore(databaseFor(source));
  }

  list(): Member[] {
    return (
      this.gatewayDatabase.db
        .prepare(
          "SELECT member_id, label, created_at FROM members ORDER BY created_at, member_id"
        )
        .all() as unknown as MemberRow[]
    ).map(toMember);
  }

  get(memberId: string): Member | undefined {
    const row = this.gatewayDatabase.db
      .prepare(
        "SELECT member_id, label, created_at FROM members WHERE member_id = ?"
      )
      .get(memberId) as MemberRow | undefined;
    return row ? toMember(row) : undefined;
  }

  /** Resolve a CLI/UI selector: an exact id first, then an exact label. */
  find(selector: string): Member | undefined {
    return (
      this.get(selector) ??
      this.list().find((member) => member.label === selector)
    );
  }

  create(label: string): Member {
    return this.gatewayDatabase.transaction(() =>
      this.createWithinTransaction(label)
    );
  }

  createWithinTransaction(label: string): Member {
    const trimmed = label.trim();
    if (!trimmed) throw new Error("member label must not be empty");
    const memberId = crypto.randomUUID();
    this.gatewayDatabase.db
      .prepare(
        "INSERT INTO members (member_id, label, created_at) VALUES (?, ?, ?)"
      )
      .run(memberId, trimmed, Date.now());
    const created = this.get(memberId);
    if (!created)
      throw new Error("member row vanished immediately after insert");
    return created;
  }

  rename(memberId: string, label: string): Member {
    const trimmed = label.trim();
    if (!trimmed) throw new Error("member label must not be empty");
    const changed = this.gatewayDatabase.db
      .prepare("UPDATE members SET label = ? WHERE member_id = ?")
      .run(trimmed, memberId);
    if (changed.changes !== 1)
      throw new Error(`no member matches "${memberId}"`);
    const renamed = this.get(memberId);
    if (!renamed)
      throw new Error("member row vanished immediately after rename");
    return renamed;
  }

  grants(memberId: string): MemberGrant[] {
    return (
      this.gatewayDatabase.db
        .prepare(
          "SELECT vault_id, role FROM member_roles WHERE member_id = ? ORDER BY vault_id"
        )
        .all(memberId) as Array<{ vault_id: string; role: GrantableRole }>
    ).map((row) => ({ vaultId: row.vault_id, role: row.role }));
  }

  roleIn(memberId: string, vaultId: string): GrantableRole | undefined {
    const row = this.gatewayDatabase.db
      .prepare(
        "SELECT role FROM member_roles WHERE member_id = ? AND vault_id = ?"
      )
      .get(memberId, vaultId) as { role: GrantableRole } | undefined;
    return row?.role;
  }

  setGrant(memberId: string, vaultId: string, role: GrantableRole): void {
    this.gatewayDatabase.transaction(() =>
      this.setGrantWithinTransaction(memberId, vaultId, role)
    );
  }

  setGrantWithinTransaction(
    memberId: string,
    vaultId: string,
    role: GrantableRole
  ): void {
    this.gatewayDatabase.db
      .prepare(
        `INSERT INTO member_roles (member_id, vault_id, role) VALUES (?, ?, ?)
         ON CONFLICT(member_id, vault_id) DO UPDATE SET role = excluded.role`
      )
      .run(memberId, vaultId, role);
  }

  clearGrant(memberId: string, vaultId: string): void {
    this.gatewayDatabase.db
      .prepare("DELETE FROM member_roles WHERE member_id = ? AND vault_id = ?")
      .run(memberId, vaultId);
  }

  /** Members holding `admin` in this vault — the ≥1-owner invariant's subject. */
  adminsOf(vaultId: string): string[] {
    return (
      this.gatewayDatabase.db
        .prepare(
          `SELECT member_id FROM member_roles
            WHERE vault_id = ? AND role = 'admin' ORDER BY member_id`
        )
        .all(vaultId) as Array<{ member_id: string }>
    ).map((row) => row.member_id);
  }

  /** Vaults this member would leave without an admin if they were removed. */
  vaultsLosingLastAdmin(memberId: string): string[] {
    return this.grants(memberId)
      .filter((grant) => grant.role === "admin")
      .filter((grant) => {
        const admins = this.adminsOf(grant.vaultId);
        return admins.length === 1 && admins[0] === memberId;
      })
      .map((grant) => grant.vaultId);
  }

  /**
   * Remove a person: one transaction that drops the grants, the device
   * bindings, and the member row. `ON DELETE CASCADE` would already reach
   * both children, but the deletes are spelled out so the operation reads as
   * what it is and survives a future FK-pragma change.
   */
  remove(memberId: string): {
    removedEndpointIds: string[];
    removedVaultIds: string[];
  } {
    return this.gatewayDatabase.transaction(() => {
      const endpointIds = (
        this.gatewayDatabase.db
          .prepare("SELECT endpoint_id FROM devices WHERE member_id = ?")
          .all(memberId) as Array<{ endpoint_id: string }>
      ).map((row) => row.endpoint_id);
      const vaultIds = this.grants(memberId).map((grant) => grant.vaultId);
      this.gatewayDatabase.db
        .prepare(
          "DELETE FROM device_checkpoints WHERE endpoint_id IN (SELECT endpoint_id FROM devices WHERE member_id = ?)"
        )
        .run(memberId);
      this.gatewayDatabase.db
        .prepare("DELETE FROM devices WHERE member_id = ?")
        .run(memberId);
      this.gatewayDatabase.db
        .prepare("DELETE FROM member_roles WHERE member_id = ?")
        .run(memberId);
      const deleted = this.gatewayDatabase.db
        .prepare("DELETE FROM members WHERE member_id = ?")
        .run(memberId);
      if (deleted.changes !== 1)
        throw new Error(`no member matches "${memberId}"`);
      return { removedEndpointIds: endpointIds, removedVaultIds: vaultIds };
    });
  }

  /** Drop every grant on an erased vault; members and devices survive. */
  removeVault(vaultId: string): void {
    this.gatewayDatabase.db
      .prepare("DELETE FROM member_roles WHERE vault_id = ?")
      .run(vaultId);
  }
}
