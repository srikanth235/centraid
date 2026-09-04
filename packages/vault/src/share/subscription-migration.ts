/*
 * LIVE COMMONS BECOME SUBSCRIPTIONS, ONCE (#929, wave 4).
 *
 * The steward vault BECOMES the origin — it already held the container and
 * serialized every write, so nothing moves. What changes is that the ROSTER
 * stops being a second membership plane: each current member's row becomes one
 * standing answer in `share_authority` and one delivery row in
 * `share_fulfillment`, which is what the subscription loop reads.
 *
 * ONE-SHOT and IDEMPOTENT. It runs over data that already exists on members'
 * machines and nobody gets to re-run it against the pre-migration shape, so a
 * second pass must be a no-op rather than a second set of answers.
 *
 * A member who is NOT current is not an audience: their answer is revoked here
 * rather than left standing, because a live answer whose roster row is gone is
 * exactly the drift this plane exists to prevent. Their LEDGER ROWS stay — the
 * origin owns them, and a departure has never been a reason to rewrite history.
 */

import type { DatabaseSync } from "node:sqlite";

import type { VaultDb } from "../db.js";
import { channelForParty } from "../grant/channel.js";
import { setFulfillmentState } from "../grant/grant-fulfillment-rows.js";
import {
  createShareGrant,
  listShareGrantsForSubject,
  revokeShareGrant,
} from "../grant/grant-store.js";
import type { ShareGrantCapability } from "../grant/grant-store.js";
import { fulfillmentAnswerFor } from "../grant/subject-registry.js";
import type { ShareableItemType } from "./closure.js";
import { isShareableItemType } from "./closure.js";

export interface CommonsMigrationReport {
  /** Circle grants walked. */
  grantsMigrated: number;
  /** Audiences that gained a subscription in this pass. */
  audiences: number;
  /** Answers ended because their roster row is no longer current. */
  revoked: number;
  /** Containers the subject registry cannot honour, named rather than dropped. */
  unofferable: readonly string[];
}

interface CircleGrantRow {
  grant_id: string;
  circle_id: string;
  container_type: string;
  container_id: string;
  steward_party_id: string;
}

interface RosterRow {
  party_id: string;
  capability: string;
}

function liveCircleGrants(db: DatabaseSync): CircleGrantRow[] {
  return db
    .prepare(
      `SELECT grant_id, circle_id, container_type, container_id,
              steward_party_id
         FROM share_circle_grant
        WHERE revoked_at IS NULL
        ORDER BY created_at, grant_id`
    )
    .all() as unknown as CircleGrantRow[];
}

/** CURRENT members only: `invited` never arrived and `refused` said no. */
function currentRoster(db: DatabaseSync, grant: CircleGrantRow): RosterRow[] {
  return db
    .prepare(
      `SELECT m.party_id, COALESCE(c.capability, 'read') AS capability
         FROM share_commons_member_state m
         LEFT JOIN social_circle_member c
           ON c.circle_id = ? AND c.party_id = m.party_id
        WHERE m.grant_id = ? AND m.status = 'current'
        ORDER BY m.party_id`
    )
    .all(grant.circle_id, grant.grant_id) as unknown as RosterRow[];
}

/** `edit` only where the subject registry can honour it; otherwise `view`. */
function capabilityOf(
  containerType: ShareableItemType,
  rosterCapability: string
): ShareGrantCapability {
  const editable = fulfillmentAnswerFor(containerType, "edit") !== undefined;
  return editable && rosterCapability === "read+write" ? "edit" : "view";
}

/**
 * Run the migration. The caller owns the transaction: a half-migrated roster is
 * the one outcome running it again cannot repair.
 */
export function migrateCommonsToSubscriptions(
  origin: VaultDb,
  input: { stewardVaultId: string; now: string }
): CommonsMigrationReport {
  const db = origin.vault;
  const unofferable: string[] = [];
  let grantsMigrated = 0;
  let audiences = 0;
  let revoked = 0;
  for (const grant of liveCircleGrants(db)) {
    grantsMigrated += 1;
    if (!isShareableItemType(grant.container_type)) {
      unofferable.push(`${grant.container_type} ${grant.container_id}`);
      continue;
    }
    const containerType = grant.container_type;
    const roster = currentRoster(db, grant);
    const current = new Map(
      roster.map((member) => [member.party_id, member.capability])
    );
    // An answer whose roster row is gone ends here, not at the next drift.
    for (const answer of listShareGrantsForSubject(
      db,
      containerType,
      grant.container_id
    )) {
      if (answer.audience.kind !== "party") continue;
      if (answer.audience.id === grant.steward_party_id) continue;
      if (current.has(answer.audience.id)) continue;
      revokeShareGrant(db, { grantId: answer.grantId, revokedAt: input.now });
      revoked += 1;
    }
    for (const member of roster) {
      if (member.party_id === grant.steward_party_id) continue;
      const created = createShareGrant(db, {
        audience: { kind: "party", id: member.party_id },
        subjectType: containerType,
        subjectId: grant.container_id,
        capability: capabilityOf(containerType, member.capability),
        grantedAt: input.now,
        grantedBy: grant.steward_party_id,
      });
      // A delivery row is what the subscription loop reads, so a migrated
      // audience is picked up on the next pass rather than on the next edit.
      const channel = channelForParty(db, member.party_id);
      if (!channel) continue;
      const held = db
        .prepare(
          `SELECT 1 AS present FROM share_fulfillment
            WHERE grant_id = ? AND peer_vault_id = ?`
        )
        .get(created.grantId, channel.vaultId);
      if (held) continue;
      setFulfillmentState(db, {
        grantId: created.grantId,
        peerVaultId: channel.vaultId,
        state: channel.state === "live" ? "syncing" : "awaiting_channel",
        updatedAt: input.now,
        detail: `migrated from the commons rail on ${input.stewardVaultId}`,
      });
      audiences += 1;
    }
  }
  return { grantsMigrated, audiences, revoked, unofferable };
}
