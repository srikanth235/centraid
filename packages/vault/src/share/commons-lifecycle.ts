// Vault-resident Commons grant and membership lifecycle. Every control-plane
// mutation is sequenced atomically in the same per-grant log as commands.

import type { DatabaseSync } from "node:sqlite";

import type { InvokeOutcome } from "../gateway/types.js";
import { uuidv7 } from "../ids.js";
import { vaultIdentityPublicKey } from "../schema/vault-identity.js";
import type { WireClosure } from "./closure.js";
import {
  compileCommons,
  commonsClosureSizeBytes,
  createCommonsGrant,
  ensureCommonsParty,
  appendCommonsOperationInTransaction,
  mutateCommonsControl,
  readCommonsGrant,
  removeCommonsFromSeat,
} from "./commons.js";
import type {
  CommonsCapability,
  CommonsGrantRecord,
  CommonsMemberInput,
  CompiledCommonsSeat,
  CreateCommonsGrantInput,
} from "./commons.js";
import type { ShareVaultRef } from "./placement.js";

export interface CommonsMemberRecord {
  partyId: string;
  capability: CommonsCapability;
  vaultId?: string;
  status: "current" | "invited";
}

export interface CommonsGrantView {
  grant: CommonsGrantRecord;
  members: readonly CommonsMemberRecord[];
  currentSizeBytes: number;
}

export function findCommonsGrantForContainer(
  db: DatabaseSync,
  containerType: string,
  containerId: string
): CommonsGrantRecord | undefined {
  const row = db
    .prepare(
      `SELECT grant_id FROM share_circle_grant
        WHERE plane = 'commons' AND container_type = ? AND container_id = ?
          AND revoked_at IS NULL`
    )
    .get(containerType, containerId) as { grant_id: string } | undefined;
  return row ? readCommonsGrant(db, row.grant_id) : undefined;
}

export function ensureCommonsGrant(input: CreateCommonsGrantInput): {
  grant: CommonsGrantRecord;
  created: boolean;
} {
  const existing = findCommonsGrantForContainer(
    input.origin,
    input.containerType,
    input.containerId
  );
  if (!existing) return { grant: createCommonsGrant(input), created: true };
  for (const member of input.members)
    upsertCommonsMember({
      steward: input.origin,
      grantId: existing.grantId,
      actorPartyId: input.ownerPartyId,
      member,
      now: input.now,
    });
  return {
    grant: readCommonsGrant(input.origin, existing.grantId),
    created: false,
  };
}

function checkpointSize(checkpointJson: string | null): number {
  if (!checkpointJson) return 0;
  return commonsClosureSizeBytes(JSON.parse(checkpointJson) as WireClosure);
}

export function listCommonsGrants(db: DatabaseSync): CommonsGrantView[] {
  const grants = db
    .prepare(
      `SELECT grant_id, checkpoint_json FROM share_circle_grant
        WHERE plane = 'commons' ORDER BY created_at, grant_id`
    )
    .all() as { grant_id: string; checkpoint_json: string | null }[];
  return grants.map((row) => {
    const grant = readCommonsGrant(db, row.grant_id);
    const members = db
      .prepare(
        `SELECT m.party_id, m.capability, s.status, b.vault_id
           FROM social_circle_member m
           JOIN share_commons_member_state s
             ON s.grant_id = ? AND s.party_id = m.party_id
           LEFT JOIN share_party_vault_binding b
             ON b.party_id = m.party_id AND b.revoked_at IS NULL
          WHERE m.circle_id = ?
          ORDER BY m.added_at, m.member_id`
      )
      .all(grant.grantId, grant.circleId) as {
      party_id: string;
      capability: CommonsCapability;
      status: "current" | "invited" | "refused";
      vault_id: string | null;
    }[];
    return {
      grant,
      members: members.map((member) => ({
        partyId: member.party_id,
        capability: member.capability,
        ...(member.status === "current" && member.vault_id
          ? { vaultId: member.vault_id }
          : {}),
        status: member.status === "current" ? "current" : "invited",
      })),
      currentSizeBytes: checkpointSize(row.checkpoint_json),
    };
  });
}

function requireSteward(grant: CommonsGrantRecord, actorPartyId: string): void {
  if (grant.stewardPartyId !== actorPartyId)
    throw new Error("only the current steward may change this commons");
  if (grant.revokedAt)
    throw new Error(`commons grant ${grant.grantId} is revoked`);
}

export function upsertCommonsMember(input: {
  steward: DatabaseSync;
  grantId: string;
  actorPartyId: string;
  member: CommonsMemberInput;
  now: string;
}): number {
  ensureCommonsParty(input.steward, input.member, input.now);
  const existing = input.steward
    .prepare(
      `SELECT m.capability, s.status FROM social_circle_member m
       JOIN share_circle_grant g ON g.circle_id = m.circle_id
       LEFT JOIN share_commons_member_state s
         ON s.grant_id = g.grant_id AND s.party_id = m.party_id
       WHERE g.grant_id = ? AND m.party_id = ?`
    )
    .get(input.grantId, input.member.partyId) as
    | {
        capability: CommonsCapability;
        status: "invited" | "current" | "refused" | null;
      }
    | undefined;
  const binding = input.member.vaultId
    ? (input.steward
        .prepare(
          `SELECT vault_id, revoked_at FROM share_party_vault_binding
            WHERE party_id = ? AND vault_id = ?`
        )
        .get(input.member.partyId, input.member.vaultId) as
        | { vault_id: string; revoked_at: string | null }
        | undefined)
    : undefined;
  const kind = existing
    ? existing.capability === input.member.capability
      ? existing.status === "refused"
        ? "member_added"
        : input.member.vaultId &&
            (existing.status !== "current" ||
              !binding ||
              binding.revoked_at !== null)
          ? "member_joined"
          : undefined
      : "capability_changed"
    : "member_added";
  if (!kind) return readCommonsGrant(input.steward, input.grantId).lastSequence;
  return mutateCommonsControl({
    steward: input.steward,
    grantId: input.grantId,
    actorPartyId: input.actorPartyId,
    kind,
    input: {
      partyId: input.member.partyId,
      capability: input.member.capability,
      ...(input.member.vaultId ? { vaultId: input.member.vaultId } : {}),
    },
    outcome: "executed",
    now: input.now,
    apply: (db, grant) => {
      requireSteward(grant, input.actorPartyId);
      db.prepare(
        `INSERT INTO social_circle_member
           (member_id, circle_id, party_id, added_at, capability)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(circle_id, party_id) DO UPDATE SET
           capability = excluded.capability`
      ).run(
        uuidv7(),
        grant.circleId,
        input.member.partyId,
        input.now,
        input.member.capability
      );
      db.prepare(
        `INSERT INTO share_commons_member_state
           (grant_id, party_id, status, accepted_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(grant_id, party_id) DO UPDATE SET
           status = excluded.status,
           accepted_at = excluded.accepted_at`
      ).run(
        input.grantId,
        input.member.partyId,
        input.member.vaultId ? "current" : "invited",
        input.member.vaultId ? input.now : null
      );
      if (input.member.vaultId) {
        const publicKey =
          input.member.vaultPublicKey ??
          (input.member.vault?.identitySeed
            ? vaultIdentityPublicKey(input.member.vault.identitySeed).toString(
                "base64"
              )
            : null);
        db.prepare(
          `INSERT INTO share_party_vault_binding
             (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL)
           ON CONFLICT(party_id, vault_id) DO UPDATE SET
             vault_public_key = COALESCE(excluded.vault_public_key, vault_public_key),
             revoked_at = NULL`
        ).run(
          uuidv7(),
          input.member.partyId,
          input.member.vaultId,
          publicKey,
          input.now
        );
      }
      if (!existing || existing.capability !== input.member.capability) {
        const siblings = db
          .prepare(
            `SELECT grant_id, steward_party_id FROM share_circle_grant
              WHERE circle_id = ? AND plane = 'commons' AND revoked_at IS NULL
                AND grant_id <> ? ORDER BY grant_id`
          )
          .all(grant.circleId, grant.grantId) as {
          grant_id: string;
          steward_party_id: string;
        }[];
        for (const sibling of siblings) {
          if (sibling.steward_party_id !== grant.stewardPartyId)
            throw new Error(
              "a shared named circle cannot change across different stewards"
            );
          if (!existing)
            db.prepare(
              `INSERT INTO share_commons_member_state
                 (grant_id, party_id, status, accepted_at)
               VALUES (?, ?, 'invited', NULL)
               ON CONFLICT(grant_id, party_id) DO NOTHING`
            ).run(sibling.grant_id, input.member.partyId);
          appendCommonsOperationInTransaction({
            steward: db,
            grantId: sibling.grant_id,
            actorPartyId: input.actorPartyId,
            kind: existing ? "capability_changed" : "member_added",
            input: {
              partyId: input.member.partyId,
              capability: input.member.capability,
            },
            outcome: "executed",
            now: input.now,
          });
        }
      }
    },
  });
}

/** Record receiver consent refusal at the steward. The member remains in the
 * named audience so a later deliberate re-invite can reopen consent without
 * inferring identity from a display name. */
export function refuseCommonsMember(input: {
  steward: DatabaseSync;
  grantId: string;
  memberPartyId: string;
  now: string;
}): number {
  return mutateCommonsControl({
    steward: input.steward,
    grantId: input.grantId,
    actorPartyId: input.memberPartyId,
    kind: "member_refused",
    input: { partyId: input.memberPartyId },
    outcome: "executed",
    now: input.now,
    apply: (db, grant) => {
      if (grant.revokedAt)
        throw new Error(`commons grant ${grant.grantId} is revoked`);
      const result = db
        .prepare(
          `UPDATE share_commons_member_state
              SET status = 'refused', accepted_at = NULL
            WHERE grant_id = ? AND party_id = ? AND status = 'invited'
              AND EXISTS (
                SELECT 1 FROM social_circle_member m
                 WHERE m.circle_id = ? AND m.party_id = ?
              )`
        )
        .run(
          grant.grantId,
          input.memberPartyId,
          grant.circleId,
          input.memberPartyId
        );
      if (result.changes !== 1)
        throw new Error("commons invitation is not pending at its steward");
    },
  });
}

export function removeCommonsMember(input: {
  steward: DatabaseSync;
  grantId: string;
  actorPartyId: string;
  memberPartyId: string;
  now: string;
}): number {
  return mutateCommonsControl({
    steward: input.steward,
    grantId: input.grantId,
    actorPartyId: input.actorPartyId,
    kind: "member_removed",
    input: { partyId: input.memberPartyId },
    outcome: "executed",
    now: input.now,
    apply: (db, grant) => {
      requireSteward(grant, input.actorPartyId);
      if (input.memberPartyId === grant.stewardPartyId)
        throw new Error("transfer stewardship before removing the steward");
      const result = db
        .prepare(
          "DELETE FROM social_circle_member WHERE circle_id = ? AND party_id = ?"
        )
        .run(grant.circleId, input.memberPartyId);
      if (result.changes !== 1)
        throw new Error("commons member is not present");
      const siblings = db
        .prepare(
          `SELECT grant_id, steward_party_id FROM share_circle_grant
            WHERE circle_id = ? AND plane = 'commons' AND revoked_at IS NULL
            ORDER BY grant_id`
        )
        .all(grant.circleId) as {
        grant_id: string;
        steward_party_id: string;
      }[];
      for (const sibling of siblings) {
        if (sibling.steward_party_id !== grant.stewardPartyId)
          throw new Error(
            "a shared named circle cannot change across different stewards"
          );
        db.prepare(
          `DELETE FROM share_commons_member_state
            WHERE grant_id = ? AND party_id = ?`
        ).run(sibling.grant_id, input.memberPartyId);
        if (sibling.grant_id !== grant.grantId)
          appendCommonsOperationInTransaction({
            steward: db,
            grantId: sibling.grant_id,
            actorPartyId: input.actorPartyId,
            kind: "member_removed",
            input: { partyId: input.memberPartyId },
            outcome: "executed",
            now: input.now,
          });
      }
    },
  });
}

export function revokeCommonsGrant(input: {
  steward: DatabaseSync;
  grantId: string;
  actorPartyId: string;
  now: string;
}): number {
  return mutateCommonsControl({
    steward: input.steward,
    grantId: input.grantId,
    actorPartyId: input.actorPartyId,
    kind: "grant_revoked",
    outcome: "executed",
    now: input.now,
    apply: (db, grant) => {
      requireSteward(grant, input.actorPartyId);
      db.prepare(
        "UPDATE share_circle_grant SET revoked_at = ? WHERE grant_id = ?"
      ).run(input.now, grant.grantId);
    },
  });
}

export function commonsSeats(input: {
  steward: DatabaseSync;
  grantId: string;
  stewardVaultId: string;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  /** Replica executor for command-tail replay (issue #750). A host that
   * cannot invoke into a mounted seat omits it and that seat re-projects. */
  invokeFor?: (
    vaultId: string,
    command: string,
    commandInput: Record<string, unknown>,
    invocationId: string
  ) => InvokeOutcome;
}): CommonsMemberInput[] {
  const grant = readCommonsGrant(input.steward, input.grantId);
  return (
    input.steward
      .prepare(
        `SELECT m.party_id, m.capability, s.status, b.vault_id
           FROM social_circle_member m
           JOIN share_commons_member_state s
             ON s.grant_id = ? AND s.party_id = m.party_id
           LEFT JOIN share_party_vault_binding b
             ON b.party_id = m.party_id AND b.revoked_at IS NULL
          WHERE m.circle_id = ?
          ORDER BY m.added_at, m.member_id`
      )
      .all(grant.grantId, grant.circleId) as {
      party_id: string;
      capability: CommonsCapability;
      status: "current" | "invited" | "refused";
      vault_id: string | null;
    }[]
  ).map((member) => {
    const vaultId =
      member.status === "current"
        ? (member.vault_id ??
          (member.party_id === grant.stewardPartyId
            ? input.stewardVaultId
            : null))
        : null;
    return {
      partyId: member.party_id,
      capability: member.capability,
      ...(vaultId
        ? {
            vaultId,
            vault: input.vaultFor(vaultId),
            ...(input.invokeFor
              ? {
                  applyCommand: (
                    command: string,
                    commandInput: Record<string, unknown>,
                    invocationId: string
                  ) =>
                    input.invokeFor!(
                      vaultId,
                      command,
                      commandInput,
                      invocationId
                    ),
                }
              : {}),
          }
        : {}),
    };
  });
}

/** Restore/mount reconciliation: vault truth recreates every joined seat's
 * mechanics and advances its logical grant-member cursor. */
export function recompileCommonsGrants(input: {
  steward: ShareVaultRef;
  stewardVaultId: string;
  /** Owner party of this local vault; member replicas never fan out. */
  stewardPartyId: string;
  /** Post-command fast path; omitted on mount/restore to reconcile all grants. */
  grantId?: string;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  invokeFor?: (
    vaultId: string,
    command: string,
    commandInput: Record<string, unknown>,
    invocationId: string
  ) => InvokeOutcome;
  now: string;
}): { grantId: string; seats: readonly CompiledCommonsSeat[] }[] {
  return listCommonsGrants(input.steward.vault)
    .filter(
      ({ grant }) =>
        !grant.revokedAt &&
        grant.stewardPartyId === input.stewardPartyId &&
        (input.grantId === undefined || grant.grantId === input.grantId)
    )
    .map(({ grant }) => ({
      grantId: grant.grantId,
      seats: compileCommons({
        steward: input.steward,
        stewardVaultId: input.stewardVaultId,
        grantId: grant.grantId,
        seats: commonsSeats({
          steward: input.steward.vault,
          grantId: grant.grantId,
          stewardVaultId: input.stewardVaultId,
          vaultFor: input.vaultFor,
          ...(input.invokeFor ? { invokeFor: input.invokeFor } : {}),
        }),
        now: input.now,
      }),
    }));
}

export function scrubCommonsSeat(input: {
  seat?: ShareVaultRef;
  grantId: string;
}): number {
  return input.seat
    ? removeCommonsFromSeat({ seat: input.seat, grantId: input.grantId })
    : 0;
}
