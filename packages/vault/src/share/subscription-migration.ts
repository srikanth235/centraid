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

import { channelForParty } from "../grant/channel.js";
import { stopShareSubscription } from "../grant/fulfillment.js";
import { setFulfillmentState } from "../grant/grant-fulfillment-rows.js";
import {
  createShareGrant,
  listShareGrantsForSubject,
  revokeShareGrant,
} from "../grant/grant-store.js";
import type {
  ShareDeparturePolicy,
  ShareGrantCapability,
} from "../grant/grant-store.js";
import {
  fulfillmentAnswerFor,
  isOfferableSubjectType,
} from "../grant/subject-registry.js";
import type { ShareableItemType } from "./closure.js";

/**
 * The commons rail's own tables, in dependency order for the drop (#929). They
 * are NOT in the composed schema any more, so a fresh vault has none of them;
 * a file written before this wave still does, and the migration is what turns
 * their contents into subscriptions and then takes them away. Deletion with
 * replacement: leaving them would leave a second membership plane no code
 * reads and every backup carries.
 */
export const LEGACY_COMMONS_TABLES: readonly string[] = [
  "share_commons_intent",
  "share_commons_invitation",
  "share_commons_lineage",
  "share_commons_retained",
  "share_commons_receipt",
  "share_commons_replay",
  "share_commons_cursor",
  "share_commons_verified",
  "share_commons_device_reach",
  "share_commons_steward_contact",
  "share_commons_supersession",
  "share_commons_member_state",
  "share_commons_op",
  "share_circle_grant",
];

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(name) !== undefined
  );
}

export interface CommonsMigrationReport {
  /** False when this vault never held a commons rail — a fresh file. */
  legacyPresent: boolean;
  /** Legacy tables dropped once their contents became subscriptions. */
  tablesDropped: readonly string[];
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
  departure_policy: string;
  max_size_bytes: number | null;
}

interface RosterRow {
  party_id: string;
  capability: string;
}

function liveCircleGrants(db: DatabaseSync): CircleGrantRow[] {
  return db
    .prepare(
      `SELECT grant_id, circle_id, container_type, container_id,
              steward_party_id, departure_policy, max_size_bytes
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

/**
 * EVERY party the rail ever wrote a row for, whatever its status. The revoke
 * pass is scoped to these and no wider: an answer this rail never wrote — a
 * plain `share.grant` to somebody outside the circle — is not the migration's
 * to end, and ending it would delete a share nobody asked to end.
 */
function rosterParties(db: DatabaseSync, grant: CircleGrantRow): Set<string> {
  const rows = db
    .prepare(
      `SELECT party_id FROM share_commons_member_state WHERE grant_id = ?`
    )
    .all(grant.grant_id) as unknown as { party_id: string }[];
  return new Set(rows.map((row) => row.party_id));
}

/** `edit` only where the subject registry can honour it; otherwise `view`. */
function capabilityOf(
  containerType: ShareableItemType,
  rosterCapability: string
): ShareGrantCapability {
  const editable = fulfillmentAnswerFor(containerType, "edit") !== undefined;
  return editable && rosterCapability === "read+write" ? "edit" : "view";
}

/** The rail's column is TEXT; anything the CHECK did not constrain reads as
 *  the conservative half. */
function departurePolicyOf(value: string): ShareDeparturePolicy {
  return value === "retain-ledger-history"
    ? "retain-ledger-history"
    : "remove-member-only";
}

/**
 * Run the migration. The caller owns the transaction: a half-migrated roster is
 * the one outcome running it again cannot repair.
 */
export function migrateCommonsToSubscriptions(
  db: DatabaseSync,
  input: { stewardVaultId: string; now: string }
): CommonsMigrationReport {
  const unofferable: string[] = [];
  let grantsMigrated = 0;
  let audiences = 0;
  let revoked = 0;
  if (!tableExists(db, "share_circle_grant"))
    return {
      legacyPresent: false,
      tablesDropped: [],
      grantsMigrated: 0,
      audiences: 0,
      revoked: 0,
      unofferable: [],
    };
  for (const grant of liveCircleGrants(db)) {
    grantsMigrated += 1;
    // The registry, not the closure's item list: the closure admits types
    // (`locker.item`) that `createShareGrant` refuses, and the throw escapes
    // `openVaultDb` — a file that can never be opened again.
    if (!isOfferableSubjectType(grant.container_type)) {
      unofferable.push(`${grant.container_type} ${grant.container_id}`);
      continue;
    }
    const containerType = grant.container_type;
    const roster = currentRoster(db, grant);
    const current = new Map(
      roster.map((member) => [member.party_id, member.capability])
    );
    // A DEPARTED MEMBER's answer ends here, not at the next drift — and only
    // a departed member's: the loop is scoped to parties this rail wrote a row
    // for, so an answer that came from anywhere else survives untouched.
    const onRail = rosterParties(db, grant);
    for (const answer of listShareGrantsForSubject(
      db,
      containerType,
      grant.container_id
    )) {
      if (answer.audience.kind !== "party") continue;
      if (answer.audience.id === grant.steward_party_id) continue;
      if (!onRail.has(answer.audience.id)) continue;
      if (current.has(answer.audience.id)) continue;
      revokeShareGrant(db, { grantId: answer.grantId, revokedAt: input.now });
      // REVOKING IS NOT STOPPING. Only `stopShareSubscription` moves a
      // delivered row to `remove_sent`, and only `remove_sent`/`syncing` rows
      // are swept — a projection left `delivered` under a revoked answer is an
      // audience holding rows the origin no longer projects.
      stopShareSubscription({
        origin: { vault: db },
        originVaultId: input.stewardVaultId,
        grantId: answer.grantId,
        // No transport on an OPEN: this settles state, and the sweep carries
        // the removal the moment the gateway has a channel again.
        transportFor: () => undefined,
        now: input.now,
      });
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
        // Both halves of the rail's delivery config travel with it. A ceiling
        // the owner set must not be silently widened to the vault default, and
        // an accounting group's `retain-ledger-history` is the property
        // SECURITY.md § departure rests on.
        maxSizeBytes: grant.max_size_bytes,
        departurePolicy: departurePolicyOf(grant.departure_policy),
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
  // The rail's tables go with the pass that EMPTIED them, and a pass that did
  // not empty them must not drop them: an unofferable container's grant has no
  // standing answer to become, so dropping its rail would destroy the only
  // record that the share existed. The rows survive, `unofferable` names them,
  // and a later release that teaches the registry that type finishes the job.
  const tablesDropped: string[] = [];
  if (unofferable.length === 0)
    for (const table of LEGACY_COMMONS_TABLES) {
      if (!tableExists(db, table)) continue;
      db.exec(`DROP TABLE ${JSON.stringify(table)}`);
      tablesDropped.push(table);
    }
  return {
    legacyPresent: true,
    tablesDropped,
    grantsMigrated,
    audiences,
    revoked,
    unofferable,
  };
}
