/*
 * Gateway device enrollments (issue #555).
 *
 * Rows live in `gateway.db`; `(endpoint_id, vault_id)` is the admission ACL.
 * SQLite transactions replace the former JSON reload/lock-directory protocol,
 * and deleting a row cascades its durable web sessions.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { GatewayDatabase } from './gateway-db.js';

export type DeviceTrust = 'owner' | 'full' | 'readonly' | 'revoked';
export type GrantableTrust = 'owner' | 'full' | 'readonly';

export function actingTrust(trust: DeviceTrust): boolean {
  return trust === 'owner' || trust === 'full';
}

export interface DeviceEnrollment {
  enrollmentId: string;
  endpointId: string;
  vaultId: string;
  label: string;
  platform?: string;
  trust: DeviceTrust;
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

interface EnrollmentRow {
  enrollment_id: string;
  endpoint_id: string;
  vault_id: string;
  label: string;
  platform: string | null;
  trust: DeviceTrust;
  remember_device: number;
  grant_profile_json: string | null;
  compute_json: string | null;
  checkpoint_json: string | null;
  added_at: string;
}

function databaseFor(source: string | GatewayDatabase): GatewayDatabase {
  if (source instanceof GatewayDatabase) return source;
  const resolved = path.resolve(source);
  const root =
    path.basename(resolved) === 'gateway.db' ? path.dirname(resolved) : path.dirname(resolved);
  return GatewayDatabase.open(root);
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
    vaultId: row.vault_id,
    label: row.label,
    ...(row.platform !== null ? { platform: row.platform } : {}),
    trust: row.trust,
    rememberDevice: row.remember_device === 1,
    ...(Array.isArray(grantProfile) ? { grantProfile } : {}),
    ...(compute ? { compute } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    addedAt: row.added_at,
  };
}

export class EnrollmentStore {
  readonly gatewayDatabase: GatewayDatabase;

  private constructor(gatewayDatabase: GatewayDatabase) {
    this.gatewayDatabase = gatewayDatabase;
  }

  static open(
    source: string | GatewayDatabase,
    _options: { statTtlMs?: number; now?: () => number } = {},
  ): EnrollmentStore {
    return new EnrollmentStore(databaseFor(source));
  }

  list(): DeviceEnrollment[] {
    return (
      this.gatewayDatabase.db
        .prepare(
          `SELECT enrollment_id, endpoint_id, vault_id, label, platform, trust,
                  remember_device, grant_profile_json, compute_json, checkpoint_json, added_at
             FROM devices ORDER BY added_at, enrollment_id`,
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

  vaultsFor(endpointId: string): string[] {
    return (
      this.gatewayDatabase.db
        .prepare(
          `SELECT vault_id FROM devices
            WHERE endpoint_id = ? AND trust != 'revoked'
            ORDER BY vault_id`,
        )
        .all(endpointId) as Array<{ vault_id: string }>
    ).map((row) => row.vault_id);
  }

  isEnrolled(endpointId: string): boolean {
    return this.vaultsFor(endpointId).length > 0;
  }

  enroll(input: {
    endpointId: string;
    vaultId: string;
    label: string;
    platform?: string;
    trust?: GrantableTrust;
    rememberDevice?: boolean;
    grantProfile?: string[];
  }): DeviceEnrollment {
    return this.gatewayDatabase.transaction(() => this.enrollWithinTransaction(input));
  }

  /** Shared by ticket redemption so burn + first enrollment commit atomically. */
  enrollWithinTransaction(input: {
    endpointId: string;
    vaultId: string;
    label: string;
    platform?: string;
    trust?: GrantableTrust;
    rememberDevice?: boolean;
    grantProfile?: string[];
  }): DeviceEnrollment {
    const existing = this.get(input.endpointId, input.vaultId);
    if (existing) {
      const platform = input.platform !== undefined ? input.platform : (existing.platform ?? null);
      const trust = input.trust ?? existing.trust;
      const remember = input.rememberDevice ?? existing.rememberDevice;
      const grants =
        input.grantProfile !== undefined
          ? JSON.stringify(input.grantProfile)
          : input.platform !== undefined && input.platform !== 'extension'
            ? null
            : existing.grantProfile
              ? JSON.stringify(existing.grantProfile)
              : null;
      this.gatewayDatabase.db
        .prepare(
          `UPDATE devices
              SET label = ?, platform = ?, trust = ?, remember_device = ?, grant_profile_json = ?
            WHERE enrollment_id = ?`,
        )
        .run(input.label, platform, trust, remember ? 1 : 0, grants, existing.enrollmentId);
      return this.require(input.endpointId, input.vaultId);
    }
    const enrollmentId = crypto.randomUUID();
    this.gatewayDatabase.db
      .prepare(
        `INSERT INTO devices (
          enrollment_id, endpoint_id, vault_id, label, platform, trust,
          remember_device, grant_profile_json, added_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        enrollmentId,
        input.endpointId,
        input.vaultId,
        input.label,
        input.platform ?? null,
        input.trust ?? 'full',
        input.rememberDevice === true ? 1 : 0,
        input.grantProfile ? JSON.stringify(input.grantProfile) : null,
        new Date().toISOString(),
      );
    return this.require(input.endpointId, input.vaultId);
  }

  get(endpointId: string, vaultId: string): DeviceEnrollment | undefined {
    const row = this.gatewayDatabase.db
      .prepare(
        `SELECT enrollment_id, endpoint_id, vault_id, label, platform, trust,
                remember_device, grant_profile_json, compute_json, checkpoint_json, added_at
           FROM devices WHERE endpoint_id = ? AND vault_id = ?`,
      )
      .get(endpointId, vaultId) as EnrollmentRow | undefined;
    return row ? toEnrollment(row) : undefined;
  }

  resetCheckpoint(
    endpointId: string,
    vaultId: string,
    cursor: Omit<ReplicaCheckpoint, 'updatedAt'>,
  ): ReplicaCheckpoint {
    const checkpoint = checkpointNow(cursor);
    this.updateEnrollment(endpointId, vaultId, 'checkpoint_json', JSON.stringify(checkpoint));
    return checkpoint;
  }

  advanceCheckpoint(
    endpointId: string,
    vaultId: string,
    cursor: Omit<ReplicaCheckpoint, 'updatedAt'>,
  ): ReplicaCheckpoint {
    const enrollment = this.require(endpointId, vaultId);
    const previous = enrollment.checkpoint;
    if (!previous) throw new Error('replica checkpoint must be initialized by bootstrap');
    if (previous.epoch !== cursor.epoch || previous.schemaEpoch !== cursor.schemaEpoch) {
      throw new Error('replica checkpoint epoch changed; rebootstrap required');
    }
    if (!Number.isSafeInteger(cursor.seq) || cursor.seq < previous.seq) {
      throw new Error('replica checkpoint must advance monotonically');
    }
    return this.resetCheckpoint(endpointId, vaultId, cursor);
  }

  setTrust(endpointId: string, vaultId: string, trust: DeviceTrust): DeviceEnrollment {
    return this.gatewayDatabase.transaction(() => {
      this.require(endpointId, vaultId);
      this.gatewayDatabase.db
        .prepare(
          `UPDATE devices SET trust = ?, checkpoint_json =
            CASE WHEN ? = 'revoked' THEN NULL ELSE checkpoint_json END
           WHERE endpoint_id = ? AND vault_id = ?`,
        )
        .run(trust, trust, endpointId, vaultId);
      return this.require(endpointId, vaultId);
    });
  }

  setCompute(
    enrollmentId: string,
    input: Omit<DeviceComputeProfile, 'updatedAt'>,
  ): DeviceEnrollment {
    const compute = { ...input, updatedAt: new Date().toISOString() };
    this.gatewayDatabase.db
      .prepare(
        `UPDATE devices SET compute_json = ?
          WHERE enrollment_id = ? AND trust != 'revoked'`,
      )
      .run(JSON.stringify(compute), enrollmentId);
    const row = this.list().find((candidate) => candidate.enrollmentId === enrollmentId);
    if (!row) throw new Error('device enrollment was not found');
    return row;
  }

  revoke(idOrEndpointId: string): DeviceEnrollment[] {
    return this.gatewayDatabase.transaction(() => {
      const removed = this.list().filter(
        (row) => row.enrollmentId === idOrEndpointId || row.endpointId === idOrEndpointId,
      );
      this.gatewayDatabase.db
        .prepare('DELETE FROM devices WHERE enrollment_id = ? OR endpoint_id = ?')
        .run(idOrEndpointId, idOrEndpointId);
      return removed;
    });
  }

  removeVault(vaultId: string): DeviceEnrollment[] {
    return this.gatewayDatabase.transaction(() => {
      const removed = this.listByVault(vaultId);
      this.gatewayDatabase.db.prepare('DELETE FROM devices WHERE vault_id = ?').run(vaultId);
      return removed;
    });
  }

  private require(endpointId: string, vaultId: string): DeviceEnrollment {
    const enrollment = this.get(endpointId, vaultId);
    if (!enrollment || enrollment.trust === 'revoked') {
      throw new Error('device is not enrolled for this vault');
    }
    return enrollment;
  }

  private updateEnrollment(
    endpointId: string,
    vaultId: string,
    column: 'checkpoint_json',
    value: string,
  ): void {
    this.require(endpointId, vaultId);
    this.gatewayDatabase.db
      .prepare(`UPDATE devices SET ${column} = ? WHERE endpoint_id = ? AND vault_id = ?`)
      .run(value, endpointId, vaultId);
  }
}

function checkpointNow(cursor: Omit<ReplicaCheckpoint, 'updatedAt'>): ReplicaCheckpoint {
  if (
    !cursor.epoch ||
    !Number.isSafeInteger(cursor.seq) ||
    cursor.seq < 0 ||
    !Number.isSafeInteger(cursor.schemaEpoch) ||
    cursor.schemaEpoch < 0
  ) {
    throw new Error('invalid replica checkpoint');
  }
  return { ...cursor, updatedAt: new Date().toISOString() };
}
