import { afterEach, describe, expect, test } from "vitest";

import { registerTallyCommands } from "../commands/tally.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso, uuidv7 } from "../ids.js";
import { commonsSeats, ensureCommonsGrant } from "./commons-lifecycle.js";
import { closeOpenVaults, household } from "./placement-fixture.js";

function addParty(
  db: ReturnType<typeof household>["origin"]["vault"],
  name: string,
  now: string
): string {
  const partyId = uuidv7();
  db.prepare(
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, birth_date,
        avatar_content_id, created_at, updated_at)
     VALUES (?, 'person', ?, ?, NULL, NULL, ?, ?)`
  ).run(partyId, name, name, now, now);
  return partyId;
}

describe("incremental Tally commons sharing", () => {
  afterEach(closeOpenVaults);

  test("refuses a foreign or projected named circle as grant authority", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const foreignOwner = addParty(origin.vault, "Foreign owner", now);
    const foreignCircle = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
         VALUES (?, ?, 'Foreign audience', 'custom')`
      )
      .run(foreignCircle, foreignOwner);

    expect(() =>
      ensureCommonsGrant({
        origin: origin.vault,
        ownerPartyId: originBoot.ownerPartyId,
        circleId: foreignCircle,
        containerType: "core.collection",
        containerId: uuidv7(),
        members: [],
        now,
      })
    ).toThrow("owner-controlled circle");
    expect(
      origin.vault.prepare("SELECT COUNT(*) AS n FROM share_circle_grant").get()
    ).toMatchObject({ n: 0 });

    const projectedCircle = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
         VALUES (?, ?, 'Projected audience', 'custom')`
      )
      .run(projectedCircle, originBoot.ownerPartyId);
    origin.vault
      .prepare(
        `INSERT INTO social_circle_member
           (member_id, circle_id, party_id, added_at, capability)
         VALUES (?, ?, ?, ?, 'read+write')`
      )
      .run(uuidv7(), projectedCircle, originBoot.ownerPartyId, now);
    origin.vault
      .prepare(
        `INSERT INTO core_share_origin
           (target_type, target_id, origin_vault_id, origin_item_id,
            shared_by, shared_at)
         VALUES ('social.circle', ?, 'another-vault', ?,
                 'commons:another-grant', ?)`
      )
      .run(projectedCircle, projectedCircle, Date.parse(now));
    expect(() =>
      ensureCommonsGrant({
        origin: origin.vault,
        ownerPartyId: originBoot.ownerPartyId,
        circleId: projectedCircle,
        containerType: "core.collection",
        containerId: uuidv7(),
        members: [],
        now,
      })
    ).toThrow("projected Commons circle");
  });

  test("reuses one active grant and compiles the full group circle roster", () => {
    const { origin, originBoot, audience } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now);
    const carol = addParty(origin.vault, "Carol", now);
    const gateway = createGateway(origin);
    registerTallyCommands(gateway);
    const credential: Credential = {
      kind: "device",
      deviceId: originBoot.deviceId,
      deviceKey: originBoot.deviceKey,
    };
    const created = gateway.invoke(credential, {
      command: "tally.create_group",
      input: { name: "Trip", icon: "🧳", member_ids: [bob, carol] },
      purpose: "dpv:ServiceProvision",
    });
    expect(created.status).toBe("executed");
    const groupId = (created as { output: { group_id: string } }).output
      .group_id;
    const first = ensureCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "tally.group",
      containerId: groupId,
      members: [
        {
          partyId: bob,
          capability: "read+write",
          vaultId: "vault-family",
          vault: audience,
        },
        { partyId: carol, capability: "read+write" },
      ],
      now,
    });
    const second = ensureCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "tally.group",
      containerId: groupId,
      members: [{ partyId: carol, capability: "read" }],
      now,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.grant.grantId).toBe(first.grant.grantId);
    expect(
      origin.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_circle_grant WHERE container_type = 'tally.group' AND container_id = ?"
        )
        .get(groupId)
    ).toMatchObject({ n: 1 });
    expect(
      commonsSeats({
        steward: origin.vault,
        grantId: first.grant.grantId,
        stewardVaultId: "vault-priya",
        vaultFor: (vaultId) =>
          vaultId === "vault-priya"
            ? origin
            : vaultId === "vault-family"
              ? audience
              : undefined,
      }).map((seat) => ({
        partyId: seat.partyId,
        capability: seat.capability,
        joined: Boolean(seat.vault),
      }))
    ).toStrictEqual([
      {
        partyId: originBoot.ownerPartyId,
        capability: "read+write",
        joined: true,
      },
      { partyId: bob, capability: "read+write", joined: true },
      { partyId: carol, capability: "read", joined: false },
    ]);
  });

  test("named Tally selection cannot omit a member or rewrite capabilities", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now);
    const carol = addParty(origin.vault, "Carol", now);
    const gateway = createGateway(origin);
    registerTallyCommands(gateway);
    const created = gateway.invoke(
      {
        kind: "device",
        deviceId: originBoot.deviceId,
        deviceKey: originBoot.deviceKey,
      },
      {
        command: "tally.create_group",
        input: { name: "Exact", icon: "🧭", member_ids: [bob, carol] },
      }
    );
    if (created.status !== "executed")
      throw new Error(`group creation failed: ${JSON.stringify(created)}`);
    const groupId = (created.output as { group_id: string }).group_id;

    expect(() =>
      ensureCommonsGrant({
        origin: origin.vault,
        ownerPartyId: originBoot.ownerPartyId,
        containerType: "tally.group",
        containerId: groupId,
        members: [{ partyId: bob, capability: "read+write" }],
        now,
      })
    ).toThrow("exact stored roster and capabilities");
    expect(() =>
      ensureCommonsGrant({
        origin: origin.vault,
        ownerPartyId: originBoot.ownerPartyId,
        containerType: "tally.group",
        containerId: groupId,
        members: [
          { partyId: bob, capability: "read" },
          { partyId: carol, capability: "read+write" },
        ],
        now,
      })
    ).toThrow("exact stored roster and capabilities");
  });

  test("one named-circle roster command sequences every active grant", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const bob = addParty(origin.vault, "Bob", now);
    const carol = addParty(origin.vault, "Carol", now);
    const changed: string[] = [];
    const gateway = createGateway(origin, {
      onCommonsCommandSequenced: (grantId) => changed.push(grantId),
    });
    registerTallyCommands(gateway);
    const credential: Credential = {
      kind: "device",
      deviceId: originBoot.deviceId,
      deviceKey: originBoot.deviceKey,
    };
    const created = gateway.invoke(credential, {
      command: "tally.create_group",
      input: { name: "Reusable", icon: "👥", member_ids: [bob] },
    });
    if (created.status !== "executed")
      throw new Error(`group creation failed: ${JSON.stringify(created)}`);
    const groupId = (created.output as { group_id: string }).group_id;
    const circleId = (
      origin.vault
        .prepare("SELECT circle_id FROM tally_group WHERE group_id = ?")
        .get(groupId) as { circle_id: string }
    ).circle_id;
    const tally = ensureCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "tally.group",
      containerId: groupId,
      members: [{ partyId: bob, capability: "read+write" }],
      now,
    }).grant;
    const collectionId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO core_collection
           (collection_id, owner_party_id, name, cover_content_id,
            parent_collection_id, sort_order, created_at)
         VALUES (?, ?, 'Shared audience', NULL, NULL, 0, ?)`
      )
      .run(collectionId, originBoot.ownerPartyId, now);
    const docs = ensureCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      circleId,
      containerType: "core.collection",
      containerId: collectionId,
      members: [{ partyId: bob, capability: "read+write" }],
      now,
    }).grant;

    expect(
      gateway.invoke(credential, {
        command: "tally.add_group_member",
        input: { group_id: groupId, party_id: carol },
      }).status
    ).toBe("executed");
    for (const grant of [tally, docs])
      expect(
        origin.vault
          .prepare(
            `SELECT status FROM share_commons_member_state
              WHERE grant_id = ? AND party_id = ?`
          )
          .get(grant.grantId, carol)
      ).toMatchObject({ status: "invited" });
    expect(new Set(changed)).toStrictEqual(
      new Set([tally.grantId, docs.grantId])
    );
    expect(
      origin.vault
        .prepare(
          `SELECT kind FROM share_commons_op
            WHERE grant_id = ? ORDER BY sequence`
        )
        .all(docs.grantId)
    ).toMatchObject([{ kind: "member_added" }]);

    changed.length = 0;
    expect(
      gateway.invoke(credential, {
        command: "tally.remove_group_member",
        input: { group_id: groupId, party_id: carol },
      }).status
    ).toBe("executed");
    for (const grant of [tally, docs])
      expect(
        origin.vault
          .prepare(
            `SELECT COUNT(*) AS n FROM share_commons_member_state
              WHERE grant_id = ? AND party_id = ?`
          )
          .get(grant.grantId, carol)
      ).toMatchObject({ n: 0 });
    expect(new Set(changed)).toStrictEqual(
      new Set([tally.grantId, docs.grantId])
    );
    expect(
      origin.vault
        .prepare(
          `SELECT kind FROM share_commons_op
            WHERE grant_id = ? ORDER BY sequence`
        )
        .all(docs.grantId)
    ).toMatchObject([{ kind: "member_added" }, { kind: "member_removed" }]);
  });
});
