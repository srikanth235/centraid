/*
 * Gateway device enrollments (#555, #599, #726).
 *
 * governance: allow-repo-hygiene file-size-limit (#608) cohesive enrollment aggregate owns atomic owner, device, ownership, checkpoint, and rename invariants
 *
 * A `devices` row is a pure BINDING of a proved iroh EndpointId to an owner,
 * and authority is ownership: a `DeviceEnrollment` is a DERIVED view over the
 * (device, owner's vaults) pairs, not a stored row. Deleting a device cascades
 * its durable web sessions and replica checkpoints.
 */

import crypto from "node:crypto";
import path from "node:path";

import { GatewayDatabase } from "./gateway-db.js";
import { OwnerStore } from "./owner-store.js";
import type { Owner } from "./owner-store.js";
import { VaultOwnedError } from "./vault-owned-error.js";

export { VaultOwnedError } from "./vault-owned-error.js";

export interface DeviceEnrollment {
  enrollmentId: string;
  endpointId: string;
  ownerId: string;
  ownerLabel: string;
  vaultId: string;
  label: string;
  platform?: string;
  revoked: boolean;
  rememberDevice: boolean;
  grantProfile?: string[];
  compute?: DeviceComputeProfile;
  checkpoint?: ReplicaCheckpoint;
  addedAt: string;
}

export interface DeviceComputeCapabilities {
  previews: boolean;
  poster: boolean;
  pdfText: boolean;
  ocr: boolean;
  embedding: boolean;
  transcript: boolean;
  edgeSeal: boolean;
  backgroundTransfer: boolean;
}

export interface DeviceComputeProfile {
  contributeWhileCharging: boolean;
  capabilities: DeviceComputeCapabilities;
  updatedAt: string;
}

export interface ReplicaCheckpoint {
  epoch: string;
  seq: number;
  schemaEpoch: number;
  updatedAt: string;
}

export interface EnrollInput {
  endpointId: string;
  label: string;
  platform?: string;
  rememberDevice?: boolean;
  grantProfile?: string[];
  ownerId?: string;
  ownerLabel?: string;
  vaultIds?: readonly string[];
}

interface EnrollmentRow {
  enrollment_id: string;
  endpoint_id: string;
  owner_id: string;
  owner_label: string;
  vault_id: string;
  label: string;
  platform: string | null;
  remember_device: number;
  grant_profile_json: string | null;
  compute_json: string | null;
  checkpoint_json: string | null;
  revoked: number;
  added_at: string;
}

const ENROLLMENT_VIEW_SQL = `
  SELECT d.enrollment_id, d.endpoint_id, d.owner_id, o.label AS owner_label,
         v.vault_id, d.label, d.platform, d.remember_device,
         d.grant_profile_json, d.compute_json, c.checkpoint_json, d.revoked, d.added_at
    FROM devices d
    JOIN owners o ON o.owner_id = d.owner_id
    JOIN vault_owners v ON v.owner_id = d.owner_id
    LEFT JOIN device_checkpoints c
      ON c.endpoint_id = d.endpoint_id AND c.vault_id = v.vault_id`;

function databaseFor(source: string | GatewayDatabase): GatewayDatabase {
  if (source instanceof GatewayDatabase) return source;
  return GatewayDatabase.open(path.dirname(path.resolve(source)));
}

function parseJson<T>(raw: string | null): T | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function toEnrollment(row: EnrollmentRow): DeviceEnrollment {
  const grantProfile = parseJson<string[]>(row.grant_profile_json);
  const compute = parseJson<DeviceComputeProfile>(row.compute_json);
  const checkpoint = parseJson<ReplicaCheckpoint>(row.checkpoint_json);
  return {
    enrollmentId: row.enrollment_id,
    endpointId: row.endpoint_id,
    ownerId: row.owner_id,
    ownerLabel: row.owner_label,
    vaultId: row.vault_id,
    label: row.label,
    ...(row.platform === null ? {} : { platform: row.platform }),
    revoked: row.revoked === 1,
    rememberDevice: row.remember_device === 1,
    ...(Array.isArray(grantProfile) ? { grantProfile } : {}),
    ...(compute ? { compute } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    addedAt: row.added_at,
  };
}

export class EnrollmentStore {
  readonly gatewayDatabase: GatewayDatabase;
  readonly owners: OwnerStore;

  private constructor(gatewayDatabase: GatewayDatabase) {
    this.gatewayDatabase = gatewayDatabase;
    this.owners = OwnerStore.open(gatewayDatabase);
  }

  static open(
    source: string | GatewayDatabase,
    _options: { statTtlMs?: number; now?: () => number } = {}
  ): EnrollmentStore {
    return new EnrollmentStore(databaseFor(source));
  }

  list(): DeviceEnrollment[] {
    return (
      this.gatewayDatabase.db
        .prepare(
          `${ENROLLMENT_VIEW_SQL} ORDER BY d.added_at, d.enrollment_id, v.vault_id`
        )
        .all() as unknown as EnrollmentRow[]
    ).map(toEnrollment);
  }

  listFresh(): DeviceEnrollment[] {
    return this.list();
  }

  listByVault(vaultId: string): DeviceEnrollment[] {
    return this.list().filter((row) => row.vaultId === vaultId);
  }

  ownerFor(endpointId: string): Owner | undefined {
    const row = this.gatewayDatabase.db
      .prepare(
        "SELECT owner_id FROM devices WHERE endpoint_id = ? AND revoked = 0"
      )
      .get(endpointId) as { owner_id: string } | undefined;
    return row ? this.owners.get(row.owner_id) : undefined;
  }

  vaultsFor(endpointId: string): string[] {
    return (
      this.gatewayDatabase.db
        .prepare(
          `SELECT v.vault_id FROM devices d
             JOIN vault_owners v ON v.owner_id = d.owner_id
            WHERE d.endpoint_id = ? AND d.revoked = 0
            ORDER BY v.vault_id`
        )
        .all(endpointId) as Array<{ vault_id: string }>
    ).map((row) => row.vault_id);
  }

  isEnrolled(endpointId: string): boolean {
    return this.vaultsFor(endpointId).length > 0;
  }

  enroll(input: EnrollInput): DeviceEnrollment {
    return this.gatewayDatabase.transaction(() => {
      const enrolled = this.enrollWithinTransaction(input);
      const first = enrolled[0];
      if (!first)
        throw new Error("enrollment must reach at least one owned vault");
      return first;
    });
  }

  enrollWithinTransaction(input: EnrollInput): DeviceEnrollment[] {
    const ownerId = this.resolveOwnerWithinTransaction(input);
    const label = this.uniqueDeviceLabel(input.label, input.endpointId);
    const requested = input.vaultIds ?? [];
    for (const vaultId of requested) {
      const current = this.owners.ownerOf(vaultId);
      if (current === undefined) {
        this.owners.setOwner(vaultId, ownerId);
      } else if (current !== ownerId) {
        throw new VaultOwnedError(vaultId);
      }
    }
    const existing = this.gatewayDatabase.db
      .prepare(
        "SELECT enrollment_id, platform, grant_profile_json FROM devices WHERE endpoint_id = ?"
      )
      .get(input.endpointId) as
      | {
          enrollment_id: string;
          platform: string | null;
          grant_profile_json: string | null;
        }
      | undefined;
    if (existing) {
      const platform =
        input.platform === undefined ? existing.platform : input.platform;
      const grantProfile =
        input.grantProfile === undefined
          ? input.platform !== undefined && input.platform !== "extension"
            ? null
            : existing.grant_profile_json
          : JSON.stringify(input.grantProfile);
      this.gatewayDatabase.db
        .prepare(
          `UPDATE devices
              SET owner_id = ?, label = ?, platform = ?, remember_device = ?,
                  grant_profile_json = ?, revoked = 0
            WHERE endpoint_id = ?`
        )
        .run(
          ownerId,
          label,
          platform,
          input.rememberDevice === true ? 1 : 0,
          grantProfile,
          input.endpointId
        );
    } else {
      this.gatewayDatabase.db
        .prepare(
          `INSERT INTO devices (
            enrollment_id, endpoint_id, owner_id, label, platform,
            remember_device, grant_profile_json, revoked, added_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
        )
        .run(
          crypto.randomUUID(),
          input.endpointId,
          ownerId,
          label,
          input.platform ?? null,
          input.rememberDevice === true ? 1 : 0,
          input.grantProfile ? JSON.stringify(input.grantProfile) : null,
          new Date().toISOString()
        );
    }
    const vaultIds = new Set(
      requested.length > 0 ? requested : this.owners.vaultsOwnedBy(ownerId)
    );
    const rank = new Map(
      requested.map((vaultId, index) => [vaultId, index] as const)
    );
    return this.list()
      .filter(
        (row) =>
          row.endpointId === input.endpointId && vaultIds.has(row.vaultId)
      )
      .sort(
        (a, b) =>
          (rank.get(a.vaultId) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.vaultId) ?? Number.MAX_SAFE_INTEGER)
      );
  }

  private uniqueDeviceLabel(requested: string, endpointId: string): string {
    const used = new Set(
      (
        this.gatewayDatabase.db
          .prepare(
            "SELECT label FROM devices WHERE endpoint_id <> ? AND revoked = 0"
          )
          .all(endpointId) as Array<{ label: string }>
      ).map((row) => row.label)
    );
    if (!used.has(requested)) return requested;

    const endpointLabel = `${requested} · ${endpointId}`;
    if (!used.has(endpointLabel)) return endpointLabel;
    for (let ordinal = 2; ; ordinal += 1) {
      const candidate = `${endpointLabel} (${ordinal})`;
      if (!used.has(candidate)) return candidate;
    }
  }

  get(endpointId: string, vaultId: string): DeviceEnrollment | undefined {
    const row = this.gatewayDatabase.db
      .prepare(
        `${ENROLLMENT_VIEW_SQL} WHERE d.endpoint_id = ? AND v.vault_id = ?`
      )
      .get(endpointId, vaultId) as EnrollmentRow | undefined;
    return row ? toEnrollment(row) : undefined;
  }

  hadReplicaScope(endpointId: string, vaultId: string): boolean {
    return Boolean(
      this.gatewayDatabase.db
        .prepare(
          `SELECT 1 FROM device_checkpoints
            WHERE endpoint_id = ? AND vault_id = ?`
        )
        .get(endpointId, vaultId)
    );
  }

  resetCheckpoint(
    endpointId: string,
    vaultId: string,
    cursor: Omit<ReplicaCheckpoint, "updatedAt">
  ): ReplicaCheckpoint {
    const checkpoint = checkpointNow(cursor);
    this.require(endpointId, vaultId);
    this.gatewayDatabase.db
      .prepare(
        `INSERT INTO device_checkpoints (endpoint_id, vault_id, checkpoint_json)
         VALUES (?, ?, ?)
         ON CONFLICT(endpoint_id, vault_id)
           DO UPDATE SET checkpoint_json = excluded.checkpoint_json`
      )
      .run(endpointId, vaultId, JSON.stringify(checkpoint));
    return checkpoint;
  }

  advanceCheckpoint(
    endpointId: string,
    vaultId: string,
    cursor: Omit<ReplicaCheckpoint, "updatedAt">
  ): ReplicaCheckpoint {
    const enrollment = this.require(endpointId, vaultId);
    const previous = enrollment.checkpoint;
    if (!previous)
      throw new Error("replica checkpoint must be initialized by bootstrap");
    if (
      previous.epoch !== cursor.epoch ||
      previous.schemaEpoch !== cursor.schemaEpoch
    ) {
      throw new Error("replica checkpoint epoch changed; rebootstrap required");
    }
    if (!Number.isSafeInteger(cursor.seq) || cursor.seq < previous.seq) {
      throw new Error("replica checkpoint must advance monotonically");
    }
    return this.resetCheckpoint(endpointId, vaultId, cursor);
  }

  setCompute(
    enrollmentId: string,
    input: Omit<DeviceComputeProfile, "updatedAt">
  ): DeviceEnrollment {
    const compute = { ...input, updatedAt: new Date().toISOString() };
    this.gatewayDatabase.db
      .prepare(
        "UPDATE devices SET compute_json = ? WHERE enrollment_id = ? AND revoked = 0"
      )
      .run(JSON.stringify(compute), enrollmentId);
    const row = this.list().find(
      (candidate) => candidate.enrollmentId === enrollmentId
    );
    if (!row) throw new Error("device enrollment was not found");
    return row;
  }

  revoke(idOrEndpointId: string): DeviceEnrollment[] {
    return this.gatewayDatabase.transaction(() => {
      const removed = this.list().filter(
        (row) =>
          !row.revoked &&
          (row.enrollmentId === idOrEndpointId ||
            row.endpointId === idOrEndpointId)
      );
      for (const endpointId of new Set(removed.map((row) => row.endpointId))) {
        this.tombstoneWithinTransaction(endpointId);
      }
      return removed;
    });
  }

  rename(enrollmentId: string, label: string): DeviceEnrollment {
    const trimmed = label.trim();
    if (!trimmed) throw new Error("device label must not be empty");
    const updated = this.gatewayDatabase.db
      .prepare(
        "UPDATE devices SET label = ? WHERE enrollment_id = ? AND revoked = 0"
      )
      .run(trimmed, enrollmentId);
    if (updated.changes !== 1)
      throw new Error("device enrollment was not found");
    const row = this.list().find(
      (candidate) => candidate.enrollmentId === enrollmentId
    );
    if (!row) throw new Error("device enrollment vanished after rename");
    return row;
  }

  removeOwner(ownerId: string): DeviceEnrollment[] {
    const removed = this.list().filter((row) => row.ownerId === ownerId);
    this.owners.remove(ownerId);
    return removed;
  }

  removeVault(vaultId: string): DeviceEnrollment[] {
    return this.gatewayDatabase.transaction(() => {
      const removed = this.listByVault(vaultId);
      this.gatewayDatabase.db
        .prepare("DELETE FROM device_checkpoints WHERE vault_id = ?")
        .run(vaultId);
      this.owners.removeVault(vaultId);
      return removed;
    });
  }

  private tombstoneWithinTransaction(endpointId: string): void {
    this.gatewayDatabase.db
      .prepare("UPDATE devices SET revoked = 1 WHERE endpoint_id = ?")
      .run(endpointId);
    this.gatewayDatabase.db
      .prepare("DELETE FROM device_checkpoints WHERE endpoint_id = ?")
      .run(endpointId);
    this.gatewayDatabase.db
      .prepare("DELETE FROM web_sessions WHERE device_key = ?")
      .run(endpointId);
  }

  private resolveOwnerWithinTransaction(input: EnrollInput): string {
    if (input.ownerId !== undefined) {
      const owner = this.owners.get(input.ownerId);
      if (!owner) throw new Error(`no owner matches "${input.ownerId}"`);
      return owner.ownerId;
    }
    if (input.ownerLabel !== undefined) {
      return this.owners.createWithinTransaction(input.ownerLabel).ownerId;
    }
    const bound = this.gatewayDatabase.db
      .prepare("SELECT owner_id FROM devices WHERE endpoint_id = ?")
      .get(input.endpointId) as { owner_id: string } | undefined;
    if (bound) return bound.owner_id;
    return this.owners.createWithinTransaction(input.label).ownerId;
  }

  private require(endpointId: string, vaultId: string): DeviceEnrollment {
    const enrollment = this.get(endpointId, vaultId);
    if (!enrollment || enrollment.revoked) {
      throw new Error("device is not enrolled for this vault");
    }
    return enrollment;
  }
}

function checkpointNow(
  cursor: Omit<ReplicaCheckpoint, "updatedAt">
): ReplicaCheckpoint {
  if (
    !cursor.epoch ||
    !Number.isSafeInteger(cursor.seq) ||
    cursor.seq < 0 ||
    !Number.isSafeInteger(cursor.schemaEpoch) ||
    cursor.schemaEpoch < 0
  ) {
    throw new Error("invalid replica checkpoint");
  }
  return { ...cursor, updatedAt: new Date().toISOString() };
}
