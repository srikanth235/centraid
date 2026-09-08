/*
 * LIVE COMMONS BECOME SUBSCRIPTIONS, ONCE (#929, wave 4). RED FIRST: the
 * migration is a one-shot over data that already exists on members' machines,
 * so the case that matters is the one nobody gets to re-run — a live Tally
 * commons of three members across two gateways must come out the other side
 * with every member still reachable and every ledger row still there.
 *
 * The rail's tables are NOT in the composed schema any more, so this seeds them
 * the way a pre-migration file holds them. That is the honest fixture for a
 * migration: the shape it reads is one no current code writes.
 */

import { afterEach, describe, expect, test } from "vitest";

import { registerTallyCommands } from "../commands/tally.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import {
  createShareGrant,
  listShareGrantsForSubject,
  readShareGrant,
} from "../grant/grant-store.js";
import { nowIso, uuidv7 } from "../ids.js";
import type { Household } from "./placement-fixture.js";
import { closeOpenVaults, household } from "./placement-fixture.js";
import { migrateCommonsToSubscriptions } from "./subscription-migration.js";

/** The rail tables the migration reads, as a pre-#929 file holds them. */
const LEGACY_RAIL_DDL = `
CREATE TABLE share_circle_grant (
  grant_id          TEXT PRIMARY KEY,
  circle_id         TEXT NOT NULL,
  container_type    TEXT NOT NULL,
  container_id      TEXT NOT NULL,
  departure_policy  TEXT NOT NULL DEFAULT 'remove-member-only',
  steward_party_id  TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  revoked_at        TEXT,
  max_size_bytes    INTEGER
) STRICT;
CREATE TABLE share_commons_member_state (
  grant_id    TEXT NOT NULL,
  party_id    TEXT NOT NULL,
  status      TEXT NOT NULL,
  accepted_at TEXT,
  PRIMARY KEY (grant_id, party_id)
) STRICT;
CREATE TABLE share_commons_op (
  grant_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  PRIMARY KEY (grant_id, sequence)
) STRICT;
`;

function addParty(home: Household, name: string): string {
  const partyId = uuidv7();
  const now = nowIso();
  home.origin.vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, created_at, updated_at)
       VALUES (?, 'person', ?, ?, ?, ?)`
    )
    .run(partyId, name, name, now, now);
  return partyId;
}

function bind(home: Household, partyId: string, vaultId: string): void {
  home.origin.vault
    .prepare(
      `INSERT INTO share_party_vault_binding
         (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
       VALUES (?, ?, ?, NULL, ?, NULL)`
    )
    .run(uuidv7(), partyId, vaultId, nowIso());
}

interface LegacyMember {
  partyId: string;
  capability: "read" | "read+write";
  status: "current" | "invited" | "refused";
}

/** One live commons grant on the steward's seat, as the rail wrote it. */
function seedLegacyCommons(
  home: Household,
  input: {
    circleId: string;
    containerType: string;
    containerId: string;
    members: readonly LegacyMember[];
    departurePolicy?: string;
    maxSizeBytes?: number;
  }
): string {
  const grantId = uuidv7();
  const now = nowIso();
  home.origin.vault
    .prepare(
      `INSERT INTO share_circle_grant
         (grant_id, circle_id, container_type, container_id, departure_policy,
          steward_party_id, created_at, revoked_at, max_size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    )
    .run(
      grantId,
      input.circleId,
      input.containerType,
      input.containerId,
      input.departurePolicy ?? "retain-ledger-history",
      home.originBoot.ownerPartyId,
      now,
      input.maxSizeBytes ?? null
    );
  const state = home.origin.vault.prepare(
    `INSERT INTO share_commons_member_state
       (grant_id, party_id, status, accepted_at) VALUES (?, ?, ?, ?)`
  );
  const capability = home.origin.vault.prepare(
    `INSERT INTO social_circle_member
       (member_id, circle_id, party_id, added_at, capability)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(circle_id, party_id)
       DO UPDATE SET capability = excluded.capability`
  );
  for (const member of input.members) {
    state.run(grantId, member.partyId, member.status, now);
    capability.run(
      uuidv7(),
      input.circleId,
      member.partyId,
      now,
      member.capability
    );
  }
  return grantId;
}

function seedCircle(home: Household, now: string): string {
  const circleId = uuidv7();
  home.origin.vault
    .prepare(
      `INSERT INTO social_circle
         (circle_id, name, kind, owner_party_id, created_at)
       VALUES (?, 'Trip', 'custom', ?, ?)`
    )
    .run(circleId, home.originBoot.ownerPartyId, now);
  return circleId;
}

function legacyTablesLeft(home: Household): string[] {
  return (
    home.origin.vault
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
          AND (name LIKE 'share_commons_%' OR name = 'share_circle_grant')`
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

describe("migrating a live commons", () => {
  afterEach(closeOpenVaults);

  test("a three-member Tally commons across two gateways keeps every member and every ledger row", () => {
    const home = household();
    const now = nowIso();
    home.origin.vault.exec(LEGACY_RAIL_DDL);
    const bob = addParty(home, "Bob");
    const carol = addParty(home, "Carol");
    const dev = addParty(home, "Dev");
    // Two gateways: Bob co-hosted, Carol and Dev on another. The migration
    // must not care — reach is a fact about the host, not about the roster.
    bind(home, bob, "vault-family");
    bind(home, carol, "vault-far-1");
    bind(home, dev, "vault-far-2");

    const gateway = createGateway(home.origin);
    registerTallyCommands(gateway);
    const credential: Credential = {
      kind: "device",
      deviceId: home.originBoot.deviceId,
      deviceKey: home.originBoot.deviceKey,
    };
    const created = gateway.invoke(credential, {
      command: "tally.create_group",
      input: { name: "Trip", icon: "🧳", member_ids: [bob, carol, dev] },
    });
    if (created.status !== "executed")
      throw new Error(`group creation failed: ${JSON.stringify(created)}`);
    const groupId = (created.output as { group_id: string }).group_id;
    const expense = gateway.invoke(credential, {
      command: "tally.add_expense",
      input: {
        group_id: groupId,
        description: "Hotel",
        amount_minor: 4000,
        category: "travel",
        paid_by: home.originBoot.ownerPartyId,
        splits: [
          { party_id: home.originBoot.ownerPartyId, share_minor: 1000 },
          { party_id: bob, share_minor: 1000 },
          { party_id: carol, share_minor: 1000 },
          { party_id: dev, share_minor: 1000 },
        ],
      },
    });
    expect(expense.status, JSON.stringify(expense)).toBe("executed");
    const circle = home.origin.vault
      .prepare("SELECT circle_id FROM tally_group WHERE group_id = ?")
      .get(groupId) as { circle_id: string };
    seedLegacyCommons(home, {
      circleId: circle.circle_id,
      containerType: "tally.group",
      containerId: groupId,
      members: [
        { partyId: bob, capability: "read+write", status: "current" },
        { partyId: carol, capability: "read+write", status: "current" },
        { partyId: dev, capability: "read", status: "current" },
      ],
    });
    const ledgerBefore = home.origin.vault
      .prepare("SELECT count(*) AS n FROM tally_expense_split")
      .get() as { n: number };

    const report = migrateCommonsToSubscriptions(home.origin.vault, {
      stewardVaultId: "vault-priya",
      now,
    });

    // EVERY MEMBER: one standing answer each, and the capability survives.
    expect(report.legacyPresent).toBe(true);
    expect(report.grantsMigrated).toBe(1);
    expect(report.audiences).toBe(3);
    const byParty = new Map(
      listShareGrantsForSubject(home.origin.vault, "tally.group", groupId).map(
        (grant) => [grant.audience.id, grant.capability]
      )
    );
    expect(byParty.get(bob)).toBe("edit");
    expect(byParty.get(carol)).toBe("edit");
    expect(byParty.get(dev)).toBe("view");
    // EVERY LEDGER ROW: the origin's own data is untouched by the migration.
    expect(
      home.origin.vault
        .prepare("SELECT count(*) AS n FROM tally_expense_split")
        .get()
    ).toStrictEqual(ledgerBefore);
    expect(
      home.origin.vault
        .prepare("SELECT count(*) AS n FROM tally_expense WHERE group_id = ?")
        .get(groupId)
    ).toMatchObject({ n: 1 });
    // One delivery row per audience vault, so the loop picks all three up.
    expect(
      home.origin.vault
        .prepare(
          `SELECT count(*) AS n FROM share_fulfillment
            WHERE grant_id IN (SELECT authority_id FROM share_authority
                                WHERE subject_id = ?)`
        )
        .get(groupId)
    ).toMatchObject({ n: 3 });
    // The rail goes with the pass that emptied it.
    expect([...report.tablesDropped].sort()).toStrictEqual([
      "share_circle_grant",
      "share_commons_member_state",
      "share_commons_op",
    ]);
    expect(legacyTablesLeft(home)).toStrictEqual([]);

    // ONE-SHOT: a second pass has nothing to read and changes nothing.
    const again = migrateCommonsToSubscriptions(home.origin.vault, {
      stewardVaultId: "vault-priya",
      now,
    });
    expect(again).toMatchObject({ legacyPresent: false, audiences: 0 });
    expect(
      listShareGrantsForSubject(home.origin.vault, "tally.group", groupId)
    ).toHaveLength(3);
  });

  test("a roster row that is not current is not an audience", () => {
    const home = household();
    const now = nowIso();
    home.origin.vault.exec(LEGACY_RAIL_DDL);
    const bob = addParty(home, "Bob");
    const carol = addParty(home, "Carol");
    bind(home, bob, "vault-family");
    bind(home, carol, "vault-far-1");
    const circleId = uuidv7();
    home.origin.vault
      .prepare(
        `INSERT INTO social_circle
           (circle_id, name, kind, owner_party_id, created_at)
         VALUES (?, 'Trip', 'custom', ?, ?)`
      )
      .run(circleId, home.originBoot.ownerPartyId, now);
    const containerId = uuidv7();
    seedLegacyCommons(home, {
      circleId,
      containerType: "core.collection",
      containerId,
      members: [
        { partyId: bob, capability: "read", status: "current" },
        { partyId: carol, capability: "read", status: "refused" },
      ],
    });

    const report = migrateCommonsToSubscriptions(home.origin.vault, {
      stewardVaultId: "vault-priya",
      now,
    });
    expect(report.audiences).toBe(1);
    expect(
      listShareGrantsForSubject(
        home.origin.vault,
        "core.collection",
        containerId
      ).map((grant) => grant.audience.id)
    ).toStrictEqual([bob]);
  });
  test("a departed member's answer is revoked, stopped, and their ledger rows stay", () => {
    const home = household();
    const now = nowIso();
    home.origin.vault.exec(LEGACY_RAIL_DDL);
    const bob = addParty(home, "Bob");
    bind(home, bob, "vault-family");
    const circleId = seedCircle(home, now);
    const containerId = uuidv7();

    // Bob is CURRENT on the first pass: he gets an answer and a delivery row,
    // and the delivery is marked as having reached his vault.
    seedLegacyCommons(home, {
      circleId,
      containerType: "core.collection",
      containerId,
      members: [{ partyId: bob, capability: "read", status: "current" }],
    });
    migrateCommonsToSubscriptions(home.origin.vault, {
      stewardVaultId: "vault-priya",
      now,
    });
    const [answer] = listShareGrantsForSubject(
      home.origin.vault,
      "core.collection",
      containerId
    );
    home.origin.vault
      .prepare(
        `UPDATE share_fulfillment SET state = 'delivered', delivered_at = ?
          WHERE grant_id = ?`
      )
      .run(now, answer!.grantId);

    // He departs, and the rail is seeded again with him no longer current.
    home.origin.vault.exec(LEGACY_RAIL_DDL);
    seedLegacyCommons(home, {
      circleId,
      containerType: "core.collection",
      containerId,
      members: [{ partyId: bob, capability: "read", status: "refused" }],
    });
    const report = migrateCommonsToSubscriptions(home.origin.vault, {
      stewardVaultId: "vault-priya",
      now,
    });

    expect(report.revoked).toBe(1);
    expect(
      listShareGrantsForSubject(
        home.origin.vault,
        "core.collection",
        containerId
      )
    ).toStrictEqual([]);
    // REVOKING IS NOT STOPPING: the delivered row must be swept, or Bob keeps
    // rows the origin no longer projects for him.
    expect(
      home.origin.vault
        .prepare("SELECT state FROM share_fulfillment WHERE grant_id = ?")
        .get(answer!.grantId)
    ).toMatchObject({ state: "remove_sent" });
  });

  test("an answer the rail never wrote survives the migration", () => {
    const home = household();
    const now = nowIso();
    home.origin.vault.exec(LEGACY_RAIL_DDL);
    const bob = addParty(home, "Bob");
    const carol = addParty(home, "Carol");
    bind(home, bob, "vault-family");
    bind(home, carol, "vault-far-1");
    const circleId = seedCircle(home, now);
    const containerId = uuidv7();
    // Carol was never on this circle: her share came from `share.grant`, and
    // the migration has no business ending it.
    const outside = createShareGrant(home.origin.vault, {
      audience: { kind: "party", id: carol },
      subjectType: "core.collection",
      subjectId: containerId,
      capability: "view",
      grantedAt: now,
      grantedBy: home.originBoot.ownerPartyId,
    });
    seedLegacyCommons(home, {
      circleId,
      containerType: "core.collection",
      containerId,
      members: [{ partyId: bob, capability: "read", status: "current" }],
    });

    const report = migrateCommonsToSubscriptions(home.origin.vault, {
      stewardVaultId: "vault-priya",
      now,
    });

    expect(report.revoked).toBe(0);
    expect(
      listShareGrantsForSubject(
        home.origin.vault,
        "core.collection",
        containerId
      )
        .map((grant) => grant.audience.id)
        .sort()
    ).toStrictEqual([bob, carol].sort());
    expect(
      readShareGrant(home.origin.vault, outside.grantId)?.revokedAt
    ).toBeNull();
  });

  test("a container the registry cannot honour is named, never thrown, and keeps its rail", () => {
    const home = household();
    const now = nowIso();
    home.origin.vault.exec(LEGACY_RAIL_DDL);
    const bob = addParty(home, "Bob");
    bind(home, bob, "vault-family");
    const circleId = seedCircle(home, now);
    const containerId = uuidv7();
    // `locker.item` is a shareable ITEM type the subject registry stands no
    // grant over: `createShareGrant` throws, and that throw escapes
    // `openVaultDb` — a file nobody could open again.
    seedLegacyCommons(home, {
      circleId,
      containerType: "locker.item",
      containerId,
      members: [{ partyId: bob, capability: "read", status: "current" }],
    });

    const report = migrateCommonsToSubscriptions(home.origin.vault, {
      stewardVaultId: "vault-priya",
      now,
    });

    expect(report.unofferable).toStrictEqual([`locker.item ${containerId}`]);
    expect(report.audiences).toBe(0);
    // The rail STAYS: dropping it would destroy the only record of a share
    // this build cannot express.
    expect(report.tablesDropped).toStrictEqual([]);
    expect(legacyTablesLeft(home)).not.toStrictEqual([]);
  });

  test("the rail's ceiling and departure policy travel with the answer", () => {
    const home = household();
    const now = nowIso();
    home.origin.vault.exec(LEGACY_RAIL_DDL);
    const bob = addParty(home, "Bob");
    bind(home, bob, "vault-family");
    const circleId = seedCircle(home, now);
    const containerId = uuidv7();
    seedLegacyCommons(home, {
      circleId,
      containerType: "core.collection",
      containerId,
      members: [{ partyId: bob, capability: "read", status: "current" }],
      departurePolicy: "retain-ledger-history",
      maxSizeBytes: 5_000_000,
    });

    migrateCommonsToSubscriptions(home.origin.vault, {
      stewardVaultId: "vault-priya",
      now,
    });

    const [answer] = listShareGrantsForSubject(
      home.origin.vault,
      "core.collection",
      containerId
    );
    // A ceiling the owner set is not silently widened to the vault default,
    // and the policy SECURITY.md § departure rests on is not translated away.
    expect(answer?.maxSizeBytes).toBe(5_000_000);
    expect(answer?.departurePolicy).toBe("retain-ledger-history");
  });
});
