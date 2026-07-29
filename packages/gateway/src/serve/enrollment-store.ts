/*
 * Gateway device enrollments (issues #555, #599).
 *
 * Since #599 a `devices` row is a pure BINDING of a proved iroh EndpointId to
 * governance: allow-repo-hygiene file-size-limit (#608) cohesive enrollment aggregate owns atomic member, device, grant, checkpoint, and rename invariants
 * a member (`member-store.ts`), and authority is authored on `(member, vault)`
 * in `member_roles`. A `DeviceEnrollment` is therefore a DERIVED view — one
 * per (device, vault) the device's member holds a role in — not a stored row.
 * That keeps "what may this device do in this vault" answerable in one lookup
 * while leaving exactly one place where the fact is authored.
 *
 * Rows live in `gateway.db`; deleting a device cascades its durable web
 * sessions and replica checkpoints.
 */

import crypto from "node:crypto";
import path from "node:path";

import { GatewayDatabase } from "./gateway-db.js";
import { MemberStore } from "./member-store.js";
import type { Member, MemberGrant } from "./member-store.js";

/*
 * ROLE is the authority a MEMBER is granted in a vault — what they may DO.
 * Keep it distinct from trust/identity, which is whether a device is WHO it
 * claims (its proved iroh EndpointId). Both used to be called "trust"; see
 * `docs/glossary.md` for the vocabulary and the forbidden synonyms.
 *
 *   admin — everything `write` may do, plus mint invitations, grant roles,
 *           revoke devices, remove members. The founding member lands here.
 *   write — read the vault and change it. The default for every grant.
 *   read  — read/query only; any mutation is refused at the gate.
 *
 * `revoked` is NOT a role. It is a tombstone state a DEVICE is put into,
 * never granted, never offered in a picker — hence its absence from
 * `GrantableRole`, which is exactly the set a ticket grant may carry.
 */
export type DeviceRole = "admin" | "write" | "read" | "revoked";
export type GrantableRole = "admin" | "write" | "read";

/** The one predicate for "may this role mutate" — admin is write's superset. */
export function canWrite(role: DeviceRole): boolean {
  return role === "admin" || role === "write";
}

const ROLE_RANK: Record<GrantableRole, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

/** True when `candidate` grants no more authority than `ceiling`. */
export function roleWithin(
  candidate: GrantableRole,
  ceiling: GrantableRole
): boolean {
  return ROLE_RANK[candidate] <= ROLE_RANK[ceiling];
}

export interface DeviceEnrollment {
  enrollmentId: string;
  endpointId: string;
  /** The principal this device acts as — the key attribution and roles use. */
  memberId: string;
  /** Display label of that member; never a key. */
  memberLabel: string;
  vaultId: string;
  label: string;
  platform?: string;
  role: DeviceRole;
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
  /** Bind to this existing member. */
  memberId?: string;
  /** …or create a member with this label first (founding / invite lanes). */
  memberLabel?: string;
  /** Authority to author on that member as part of this enrollment. */
  grants?: readonly MemberGrant[];
  /** Single-grant convenience for the host-custody `devices add` lane. */
  vaultId?: string;
  role?: GrantableRole;
}

interface EnrollmentRow {
  enrollment_id: string;
  endpoint_id: string;
  member_id: string;
  member_label: string;
  vault_id: string;
  role: GrantableRole;
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
  SELECT d.enrollment_id, d.endpoint_id, d.member_id, m.label AS member_label,
         r.vault_id, r.role, d.label, d.platform, d.remember_device,
         d.grant_profile_json, d.compute_json, c.checkpoint_json, d.revoked, d.added_at
    FROM devices d
    JOIN members m ON m.member_id = d.member_id
    JOIN member_roles r ON r.member_id = d.member_id
    LEFT JOIN device_checkpoints c
      ON c.endpoint_id = d.endpoint_id AND c.vault_id = r.vault_id`;

function databaseFor(source: string | GatewayDatabase): GatewayDatabase {
  if (source instanceof GatewayDatabase) return source;
  const resolved = path.resolve(source);
  const root =
    path.basename(resolved) === "gateway.db"
      ? path.dirname(resolved)
      : path.dirname(resolved);
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
    memberId: row.member_id,
    memberLabel: row.member_label,
    vaultId: row.vault_id,
    label: row.label,
    ...(row.platform === null ? {} : { platform: row.platform }),
    // The tombstone wins over the member's authored role: a stolen phone
    // keeps its owner's grants on paper and none of them in practice.
    role: row.revoked === 1 ? "revoked" : row.role,
    rememberDevice: row.remember_device === 1,
    ...(Array.isArray(grantProfile) ? { grantProfile } : {}),
    ...(compute ? { compute } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    addedAt: row.added_at,
  };
}

export class EnrollmentStore {
  readonly gatewayDatabase: GatewayDatabase;
  readonly members: MemberStore;

  private constructor(gatewayDatabase: GatewayDatabase) {
    this.gatewayDatabase = gatewayDatabase;
    this.members = MemberStore.open(gatewayDatabase);
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
          `${ENROLLMENT_VIEW_SQL} ORDER BY d.added_at, d.enrollment_id, r.vault_id`
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

  /** The principal a proved EndpointId acts as, tombstone included. */
  memberFor(endpointId: string): Member | undefined {
    const row = this.gatewayDatabase.db
      .prepare(
        "SELECT member_id FROM devices WHERE endpoint_id = ? AND revoked = 0"
      )
      .get(endpointId) as { member_id: string } | undefined;
    return row ? this.members.get(row.member_id) : undefined;
  }

  vaultsFor(endpointId: string): string[] {
    return (
      this.gatewayDatabase.db
        .prepare(
          `SELECT r.vault_id FROM devices d
             JOIN member_roles r ON r.member_id = d.member_id
            WHERE d.endpoint_id = ? AND d.revoked = 0
            ORDER BY r.vault_id`
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
        throw new Error("enrollment must grant at least one vault role");
      return first;
    });
  }

  /**
   * Shared by ticket redemption so the burn, the member's grants, and the
   * device binding all commit as ONE transaction — a partial redemption
   * leaves zero enrollment rather than a half-paired device.
   */
  enrollWithinTransaction(input: EnrollInput): DeviceEnrollment[] {
    const grants = resolveGrants(input);
    const memberId = this.resolveMemberWithinTransaction(input);
    const label = this.uniqueDeviceLabel(input.label, input.endpointId);
    for (const grant of grants) {
      this.members.setGrantWithinTransaction(
        memberId,
        grant.vaultId,
        grant.role
      );
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
              SET member_id = ?, label = ?, platform = ?, remember_device = ?,
                  grant_profile_json = ?, revoked = 0
            WHERE endpoint_id = ?`
        )
        .run(
          memberId,
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
            enrollment_id, endpoint_id, member_id, label, platform,
            remember_device, grant_profile_json, revoked, added_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
        )
        .run(
          crypto.randomUUID(),
          input.endpointId,
          memberId,
          label,
          input.platform ?? null,
          input.rememberDevice === true ? 1 : 0,
          input.grantProfile ? JSON.stringify(input.grantProfile) : null,
          new Date().toISOString()
        );
    }
    const vaultIds = new Set(
      grants.length > 0
        ? grants.map((grant) => grant.vaultId)
        : this.members.grants(memberId).map((grant) => grant.vaultId)
    );
    // Row order is the CALLER's grant order, not the registry's: the redeeming
    // device lands in `enrolled[0]`, so the ticket's primary vault must stay
    // first (scenario B12 — `pair --vault Personal`).
    const rank = new Map(
      grants.map((grant, index) => [grant.vaultId, index] as const)
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

  /**
   * Household rows must remain distinguishable even when two clients submit
   * the same generated default. The gateway is the only participant with the
   * complete live roster, so resolve collisions atomically at enrollment.
   */
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
        `${ENROLLMENT_VIEW_SQL} WHERE d.endpoint_id = ? AND r.vault_id = ?`
      )
      .get(endpointId, vaultId) as EnrollmentRow | undefined;
    return row ? toEnrollment(row) : undefined;
  }

  /** Durable proof that this device previously mounted the scope. */
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

  /**
   * Author a role for the member this device belongs to, or — for the
   * `revoked` pseudo-role — tombstone the binding. The two land on different
   * layers by design (#599 Decision 6) and this is the seam that says so.
   */
  setRole(
    endpointId: string,
    vaultId: string,
    role: DeviceRole
  ): DeviceEnrollment {
    return this.gatewayDatabase.transaction(() => {
      const current = this.get(endpointId, vaultId);
      if (!current) throw new Error("device is not enrolled for this vault");
      if (role === "revoked") {
        this.tombstoneWithinTransaction(endpointId);
        const revoked = this.get(endpointId, vaultId);
        if (!revoked)
          throw new Error("device binding vanished during revocation");
        return revoked;
      }
      this.members.setGrantWithinTransaction(current.memberId, vaultId, role);
      return this.require(endpointId, vaultId);
    });
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

  /**
   * Revoke a DEVICE: tombstone the binding and drop its replica checkpoints.
   * The member and their other devices are untouched — removing a person is
   * `MemberStore.remove`, a different verb on a different layer.
   */
  revoke(idOrEndpointId: string): DeviceEnrollment[] {
    return this.gatewayDatabase.transaction(() => {
      const removed = this.list().filter(
        (row) =>
          row.role !== "revoked" &&
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

  /** Remove a person and every binding they own — the L2 revocation verb. */
  removeMember(memberId: string): DeviceEnrollment[] {
    const removed = this.list().filter((row) => row.memberId === memberId);
    this.members.remove(memberId);
    return removed;
  }

  removeVault(vaultId: string): DeviceEnrollment[] {
    return this.gatewayDatabase.transaction(() => {
      const removed = this.listByVault(vaultId);
      this.gatewayDatabase.db
        .prepare("DELETE FROM device_checkpoints WHERE vault_id = ?")
        .run(vaultId);
      this.members.removeVault(vaultId);
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
    // The binding survives as a tombstone, so the web_sessions FK cascade
    // (which fires on DELETE) never runs. Kill the durable browser sessions
    // here instead, or a revoked laptop keeps its cookie alive.
    this.gatewayDatabase.db
      .prepare("DELETE FROM web_sessions WHERE device_key = ?")
      .run(endpointId);
  }

  private resolveMemberWithinTransaction(input: EnrollInput): string {
    if (input.memberId !== undefined) {
      const member = this.members.get(input.memberId);
      if (!member) throw new Error(`no member matches "${input.memberId}"`);
      return member.memberId;
    }
    if (input.memberLabel !== undefined) {
      return this.members.createWithinTransaction(input.memberLabel).memberId;
    }
    const bound = this.gatewayDatabase.db
      .prepare("SELECT member_id FROM devices WHERE endpoint_id = ?")
      .get(input.endpointId) as { member_id: string } | undefined;
    if (bound) return bound.member_id;
    // The host-custody lane (`devices add`, loopback host enrollment) names no
    // person, so the device becomes its own low-trust member — the honest
    // answer for a communal box, and never an "Unassigned" bucket (#599 D4).
    return this.members.createWithinTransaction(input.label).memberId;
  }

  private require(endpointId: string, vaultId: string): DeviceEnrollment {
    const enrollment = this.get(endpointId, vaultId);
    if (!enrollment || enrollment.role === "revoked") {
      throw new Error("device is not enrolled for this vault");
    }
    return enrollment;
  }
}

function resolveGrants(input: EnrollInput): MemberGrant[] {
  if (input.grants !== undefined) return [...input.grants];
  if (input.vaultId !== undefined) {
    return [{ vaultId: input.vaultId, role: input.role ?? "write" }];
  }
  return [];
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
