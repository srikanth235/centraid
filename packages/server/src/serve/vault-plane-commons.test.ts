import { describe, expect, test, vi } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  commonsSeats,
  compileCommons,
  createCommonsGrant,
  recompileCommonsGrants,
  upsertCommonsMember,
} from "@centraid/vault";

import { GatewayDatabase } from "./gateway-db.js";
import { createPeerPlaneSweep } from "./peer-plane-sweep.js";
import { runWithVaultContext } from "./vault-context.js";
import { VaultLinksStore } from "./vault-links-store.js";
import type { VaultPlane } from "./vault-plane.js";
import { usePlaneFixture } from "./vault-plane.test-fixtures.js";

describe("VaultPlane ordinary Commons commands", () => {
  const fixture = usePlaneFixture();

  test("a normal steward app invoke reconciles the Tally group to its member seat", async () => {
    const member = fixture.openPlaneWith({
      bootstrap: true,
      dir: await tempDir(),
      ownerName: "Asha",
    });
    // oxlint-disable-next-line prefer-const -- the callback closes over the plane that this initialization returns
    let steward!: VaultPlane;
    steward = fixture.openPlaneWith({
      bootstrap: true,
      dir: await tempDir(),
      ownerName: "Priya",
      onCommonsCommandSequenced: (vaultId, grantId) => {
        expect(vaultId).toBe(steward.boot.vaultId);
        recompileCommonsGrants({
          steward: steward.db,
          stewardVaultId: steward.boot.vaultId,
          stewardPartyId: steward.boot.ownerPartyId,
          vaultFor: (candidate) =>
            candidate === steward.boot.vaultId
              ? steward.db
              : candidate === member.boot.vaultId
                ? member.db
                : undefined,
          grantId,
          now: new Date().toISOString(),
        });
      },
    });
    const now = new Date().toISOString();
    steward.db.vault
      .prepare(
        `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, birth_date,
          avatar_content_id, created_at, updated_at)
         VALUES (?, 'person', 'Asha', 'Asha', NULL, NULL, ?, ?)`
      )
      .run(member.boot.ownerPartyId, now, now);
    const created = await steward.invoke(steward.ownerCredential, {
      command: "tally.create_group",
      input: {
        name: "Trip",
        icon: "🧳",
        member_ids: [member.boot.ownerPartyId],
      },
    });
    expect(created.status).toBe("executed");
    const groupId = (created as { output: { group_id: string } }).output
      .group_id;
    const grant = createCommonsGrant({
      origin: steward.db.vault,
      ownerPartyId: steward.boot.ownerPartyId,
      ownerVaultId: steward.boot.vaultId,
      ownerVault: steward.db,
      containerType: "tally.group",
      containerId: groupId,
      members: [
        {
          partyId: member.boot.ownerPartyId,
          capability: "read+write",
          vaultId: member.boot.vaultId,
          vault: member.db,
        },
      ],
      now,
    });
    compileCommons({
      steward: steward.db,
      stewardVaultId: steward.boot.vaultId,
      grantId: grant.grantId,
      seats: commonsSeats({
        steward: steward.db.vault,
        grantId: grant.grantId,
        stewardVaultId: steward.boot.vaultId,
        vaultFor: (candidate) =>
          candidate === steward.boot.vaultId
            ? steward.db
            : candidate === member.boot.vaultId
              ? member.db
              : undefined,
      }),
      now,
    });

    const added = await steward.invoke(steward.ownerCredential, {
      command: "tally.add_expense",
      input: {
        group_id: groupId,
        description: "Train",
        amount_minor: 1_200,
        paid_by: steward.boot.ownerPartyId,
        category: "travel",
        splits: [
          { party_id: steward.boot.ownerPartyId, share_minor: 600 },
          { party_id: member.boot.ownerPartyId, share_minor: 600 },
        ],
      },
    });

    expect(added.status).toBe("executed");
    expect(
      member.db.vault
        .prepare(
          "SELECT description, amount_minor FROM tally_expense WHERE group_id = ?"
        )
        .get(groupId)
    ).toMatchObject({ description: "Train", amount_minor: 1_200 });
    expect(
      steward.db.vault
        .prepare(
          "SELECT sequence, outcome FROM share_commons_op WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toMatchObject({ sequence: 1, outcome: "executed" });
  });

  test("a same-machine member app write drains on the normal nudge while refusals settle and agents run only at the steward", async () => {
    // oxlint-disable-next-line prefer-const -- the member's nudge callback closes over the sweep initialized below
    let sweep!: ReturnType<typeof createPeerPlaneSweep>;
    // oxlint-disable-next-line prefer-const -- the mutually linked plane callbacks require post-declaration initialization
    let member!: VaultPlane;
    // oxlint-disable-next-line prefer-const -- the mutually linked plane callbacks require post-declaration initialization
    let steward!: VaultPlane;
    const vaultFor = (candidate: string) =>
      candidate === steward.boot.vaultId
        ? steward.db
        : candidate === member.boot.vaultId
          ? member.db
          : undefined;
    const reconcile = (grantId: string): void => {
      recompileCommonsGrants({
        steward: steward.db,
        stewardVaultId: steward.boot.vaultId,
        stewardPartyId: steward.boot.ownerPartyId,
        vaultFor,
        grantId,
        now: new Date().toISOString(),
      });
    };
    member = fixture.openPlaneWith({
      bootstrap: true,
      dir: await tempDir("commons-local-member-"),
      ownerName: "Asha",
      onCommonsIntentQueued: () => sweep.nudge(),
    });
    steward = fixture.openPlaneWith({
      bootstrap: true,
      dir: await tempDir("commons-local-steward-"),
      ownerName: "Priya",
      onCommonsCommandSequenced: (_vaultId, grantId) => reconcile(grantId),
    });
    const gatewayDb = GatewayDatabase.open(
      await tempDir("commons-local-gateway-")
    );
    fixture.push(() => gatewayDb.close());
    const links = VaultLinksStore.open(gatewayDb);
    sweep = createPeerPlaneSweep({
      links,
      commonsVaults: () =>
        [steward, member].map((plane) => ({
          vaultId: plane.boot.vaultId,
          db: plane.db,
          gateway: plane.gateway,
          credential: plane.ownerCredential,
        })),
      dial: () => undefined,
      activeIntervalMs: 10,
      idleIntervalMs: 1000,
    });
    sweep.start();
    fixture.push(() => sweep.stop());

    const now = new Date().toISOString();
    steward.db.vault
      .prepare(
        `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, birth_date,
          avatar_content_id, created_at, updated_at)
         VALUES (?, 'person', 'Asha', 'Asha', NULL, NULL, ?, ?)`
      )
      .run(member.boot.ownerPartyId, now, now);
    const created = await steward.invoke(steward.ownerCredential, {
      command: "tally.create_group",
      input: {
        name: "Local trip",
        icon: "train",
        member_ids: [member.boot.ownerPartyId],
      },
    });
    if (created.status !== "executed")
      throw new Error(`failed to create Tally group: ${created.status}`);
    const groupId = (created.output as { group_id: string }).group_id;
    const grant = createCommonsGrant({
      origin: steward.db.vault,
      ownerPartyId: steward.boot.ownerPartyId,
      ownerVaultId: steward.boot.vaultId,
      ownerVault: steward.db,
      containerType: "tally.group",
      containerId: groupId,
      members: [
        {
          partyId: member.boot.ownerPartyId,
          capability: "read+write",
          vaultId: member.boot.vaultId,
          vault: member.db,
        },
      ],
      now,
    });
    compileCommons({
      steward: steward.db,
      stewardVaultId: steward.boot.vaultId,
      grantId: grant.grantId,
      seats: commonsSeats({
        steward: steward.db.vault,
        grantId: grant.grantId,
        stewardVaultId: steward.boot.vaultId,
        vaultFor,
      }),
      now,
    });
    member.enrollApp("tally");
    member.approveAgentGrant("tally", {
      scopes: [{ schema: "tally", verbs: "read+act" }],
    });
    const memberTally = member.bridgeFor("tally");
    const expenseInput = (description: string) => ({
      group_id: groupId,
      description,
      amount_minor: 1_200,
      paid_by: member.boot.ownerPartyId,
      category: "travel",
      splits: [
        { party_id: steward.boot.ownerPartyId, share_minor: 600 },
        { party_id: member.boot.ownerPartyId, share_minor: 600 },
      ],
    });

    const queued = await memberTally({
      op: "invoke",
      payload: {
        command: "tally.add_expense",
        input: expenseInput("Member train"),
        intentId: "same-machine-member-write",
      },
    });
    expect(queued).toMatchObject({
      ok: true,
      result: {
        status: "denied",
        reason: "waiting for Priya's device",
      },
    });
    await vi.waitFor(
      () => {
        expect(
          member.db.vault
            .prepare("SELECT description FROM tally_expense WHERE group_id = ?")
            .get(groupId)
        ).toMatchObject({ description: "Member train" });
        expect(
          member.db.vault
            .prepare(
              `SELECT status, steward_label FROM share_commons_intent
                WHERE intent_id = ?`
            )
            .get("same-machine-member-write")
        ).toMatchObject({
          status: "executed",
          steward_label: "Priya's device",
        });
      },
      { timeout: 2000, interval: 10 }
    );
    expect(
      steward.db.vault
        .prepare(
          `SELECT actor_party_id, outcome FROM share_commons_op
            WHERE grant_id = ? AND signature_nonce = ?`
        )
        .get(grant.grantId, "same-machine-member-write")
    ).toMatchObject({
      actor_party_id: member.boot.ownerPartyId,
      outcome: "executed",
    });
    // Crash recovery: a committed signed nonce is authoritative, but a lost
    // post-commit projection must be rebuilt before the intent becomes
    // terminal. Replaying the same exact intent cannot append a second op.
    member.db.vault
      .prepare("DELETE FROM tally_expense WHERE group_id = ?")
      .run(groupId);
    member.db.vault
      .prepare(
        `UPDATE share_commons_intent
            SET status = 'queued', settled_at = NULL WHERE intent_id = ?`
      )
      .run("same-machine-member-write");
    await sweep.runOnce();
    expect(
      member.db.vault
        .prepare("SELECT description FROM tally_expense WHERE group_id = ?")
        .get(groupId)
    ).toMatchObject({ description: "Member train" });
    expect(
      steward.db.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM share_commons_op
            WHERE grant_id = ? AND signature_nonce = ?`
        )
        .get(grant.grantId, "same-machine-member-write")
    ).toMatchObject({ n: 1 });

    upsertCommonsMember({
      steward: steward.db.vault,
      grantId: grant.grantId,
      actorPartyId: steward.boot.ownerPartyId,
      member: {
        partyId: member.boot.ownerPartyId,
        capability: "read",
        vaultId: member.boot.vaultId,
        vault: member.db,
      },
      now: new Date().toISOString(),
    });
    reconcile(grant.grantId);
    await memberTally({
      op: "invoke",
      payload: {
        command: "tally.add_expense",
        input: expenseInput("Must be refused"),
        intentId: "same-machine-member-refusal",
      },
    });
    await vi.waitFor(
      () => {
        expect(
          member.db.vault
            .prepare(
              `SELECT status, reason FROM share_commons_intent
                WHERE intent_id = ?`
            )
            .get("same-machine-member-refusal")
        ).toMatchObject({
          status: "denied",
          reason: "this commons is read-only for this member",
        });
      },
      { timeout: 2000, interval: 10 }
    );
    expect(
      steward.db.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM tally_expense WHERE description = ?"
        )
        .get("Must be refused")
    ).toMatchObject({ n: 0 });

    const background = await runWithVaultContext(
      {
        vaultId: member.boot.vaultId,
        ownerId: member.boot.ownerPartyId,
        ownsVault: true,
      },
      () =>
        member.invokeAsAssistant({
          command: "tally.add_expense",
          input: expenseInput("Member automation must not run"),
          intentId: "member-background-write",
        })
    );
    expect(background).toMatchObject({
      status: "denied",
      reason: "commons automations execute only at the steward's seat",
    });
    expect(
      member.db.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_intent WHERE intent_id = ?"
        )
        .get("member-background-write")
    ).toMatchObject({ n: 0 });

    const stewardBackground = await runWithVaultContext(
      {
        vaultId: steward.boot.vaultId,
        ownerId: steward.boot.ownerPartyId,
        ownsVault: true,
      },
      () =>
        steward.invokeAsAssistant({
          command: "tally.add_expense",
          input: {
            ...expenseInput("Steward automation"),
            paid_by: steward.boot.ownerPartyId,
          },
          intentId: "steward-background-write",
        })
    );
    expect(stewardBackground.status).toBe("executed");
    expect(
      steward.db.vault
        .prepare(
          `SELECT actor_party_id, outcome FROM share_commons_op
            WHERE grant_id = ? AND command = 'tally.add_expense'
            ORDER BY sequence DESC LIMIT 1`
        )
        .get(grant.grantId)
    ).toMatchObject({
      actor_party_id: steward.boot.ownerPartyId,
      outcome: "executed",
    });
    expect(
      member.db.vault
        .prepare("SELECT description FROM tally_expense WHERE description = ?")
        .get("Steward automation")
    ).toMatchObject({ description: "Steward automation" });
  });
});
