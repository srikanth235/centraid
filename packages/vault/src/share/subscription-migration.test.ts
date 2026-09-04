/*
 * LIVE COMMONS BECOME SUBSCRIPTIONS, ONCE (#929, wave 4). RED FIRST: the
 * migration is a one-shot over data that already exists on members' machines,
 * so the case that matters is the one nobody gets to re-run — a live Tally
 * commons of three members across two gateways must come out the other side
 * with every member still reachable and every ledger row still there.
 *
 * The steward vault BECOMES the origin, which it already was in every way that
 * mattered: it held the container and serialized the writes. What changes is
 * that the roster stops being a second membership plane and becomes what it
 * describes — one standing answer per party, and one delivery row per audience.
 */

import { afterEach, describe, expect, test } from "vitest";

import { registerTallyCommands } from "../commands/tally.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { listShareGrantsForSubject } from "../grant/grant-store.js";
import { nowIso, uuidv7 } from "../ids.js";
import { createCommonsGrant } from "./commons.js";
import { closeOpenVaults, household } from "./placement-fixture.js";
import { migrateCommonsToSubscriptions } from "./subscription-migration.js";

function addParty(db: ReturnType<typeof household>["origin"], name: string) {
  const partyId = uuidv7();
  const now = nowIso();
  db.vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, created_at, updated_at)
       VALUES (?, 'person', ?, ?, ?, ?)`
    )
    .run(partyId, name, name, now, now);
  return partyId;
}

function bind(
  db: ReturnType<typeof household>["origin"],
  partyId: string,
  vaultId: string
): void {
  db.vault
    .prepare(
      `INSERT INTO share_party_vault_binding
         (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
       VALUES (?, ?, ?, NULL, ?, NULL)`
    )
    .run(uuidv7(), partyId, vaultId, nowIso());
}

describe("migrating a live commons", () => {
  afterEach(closeOpenVaults);

  test("a three-member Tally commons across two gateways keeps every member and every ledger row", () => {
    const home = household();
    const now = nowIso();
    const bob = addParty(home.origin, "Bob");
    const carol = addParty(home.origin, "Carol");
    const dev = addParty(home.origin, "Dev");
    // Two gateways: Bob co-hosted, Carol and Dev on another. The migration
    // must not care — reach is a fact about the host, not about the roster.
    bind(home.origin, bob, "vault-family");
    bind(home.origin, carol, "vault-far-1");
    bind(home.origin, dev, "vault-far-2");

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
      purpose: "dpv:ServiceProvision",
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
      purpose: "dpv:ServiceProvision",
    });
    expect(expense.status, JSON.stringify(expense)).toBe("executed");

    // The stored roster is what a named circle's grant must agree with. Tally
    // makes every group member a writer, so the one READER is marked here.
    const circle = home.origin.vault
      .prepare("SELECT circle_id FROM tally_group WHERE group_id = ?")
      .get(groupId) as { circle_id: string };
    home.origin.vault
      .prepare(
        `UPDATE social_circle_member SET capability = 'read'
          WHERE circle_id = ? AND party_id = ?`
      )
      .run(circle.circle_id, dev);

    const commons = createCommonsGrant({
      origin: home.origin.vault,
      ownerPartyId: home.originBoot.ownerPartyId,
      containerType: "tally.group",
      containerId: groupId,
      circleId: circle.circle_id,
      // `vaultId` is what made a member `current` on the commons rail — the
      // roster fact the migration reads as "this person is an audience".
      members: [
        { partyId: bob, capability: "read+write", vaultId: "vault-family" },
        { partyId: carol, capability: "read+write", vaultId: "vault-far-1" },
        { partyId: dev, capability: "read", vaultId: "vault-far-2" },
      ],
      now,
    });
    const ledgerBefore = home.origin.vault
      .prepare("SELECT count(*) AS n FROM tally_expense_split")
      .get() as { n: number };

    const report = migrateCommonsToSubscriptions(home.origin, {
      stewardVaultId: "vault-priya",
      now,
    });

    // EVERY MEMBER: one standing answer each, and the capability survives.
    expect(report.grantsMigrated).toBe(1);
    expect(report.audiences).toBe(3);
    const grants = listShareGrantsForSubject(
      home.origin.vault,
      "tally.group",
      groupId
    );
    const byParty = new Map(
      grants.map((grant) => [grant.audience.id, grant.capability])
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
    expect(commons.grantId).toBeTruthy();

    // ONE-SHOT: a second pass migrates nothing and changes nothing.
    const again = migrateCommonsToSubscriptions(home.origin, {
      stewardVaultId: "vault-priya",
      now,
    });
    expect(again.audiences).toBe(0);
    expect(
      listShareGrantsForSubject(home.origin.vault, "tally.group", groupId)
    ).toHaveLength(3);
  });

  test("a departed member's answer is revoked, and the ledger keeps their rows", () => {
    const home = household();
    const now = nowIso();
    const bob = addParty(home.origin, "Bob");
    const carol = addParty(home.origin, "Carol");
    bind(home.origin, bob, "vault-family");
    bind(home.origin, carol, "vault-far-1");
    const groupId = uuidv7();
    createCommonsGrant({
      origin: home.origin.vault,
      ownerPartyId: home.originBoot.ownerPartyId,
      containerType: "core.collection",
      containerId: groupId,
      members: [
        { partyId: bob, capability: "read", vaultId: "vault-family" },
        { partyId: carol, capability: "read", vaultId: "vault-far-1" },
      ],
      now,
    });
    // Carol refused: a roster row that is not `current` is not an audience.
    home.origin.vault
      .prepare(
        `UPDATE share_commons_member_state SET status = 'refused'
          WHERE party_id = ?`
      )
      .run(carol);

    const report = migrateCommonsToSubscriptions(home.origin, {
      stewardVaultId: "vault-priya",
      now,
    });
    expect(report.audiences).toBe(1);
    expect(
      listShareGrantsForSubject(
        home.origin.vault,
        "core.collection",
        groupId
      ).map((grant) => grant.audience.id)
    ).toStrictEqual([bob]);
  });
});
