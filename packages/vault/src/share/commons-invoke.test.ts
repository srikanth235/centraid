import { afterEach, describe, expect, test, vi } from "vitest";

import { enrollAgent, enrollApp } from "../bootstrap.js";
import { registerTallyCommands } from "../commands/tally.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso } from "../ids.js";
import {
  commonsCurrentSize,
  compileCommons,
  createCommonsGrant,
} from "./commons.js";
import { closeOpenVaults, household } from "./placement-fixture.js";

describe("ordinary invoke is Commons-aware", () => {
  afterEach(closeOpenVaults);

  test("member writes queue without local mutation; steward writes sequence once", () => {
    const { origin, originBoot, audience, audienceBoot } = household();
    const now = nowIso();
    // The remote party id is already the owner id of their own vault.
    const bob = audienceBoot.ownerPartyId;
    origin.vault
      .prepare(
        `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, birth_date,
          avatar_content_id, created_at, updated_at)
       VALUES (?, 'person', 'Bob', 'Bob', NULL, NULL, ?, ?)`
      )
      .run(bob, now, now);
    const reconciled = vi.fn<(grantId: string) => void>();
    const stewardGateway = createGateway(origin, {
      onCommonsCommandSequenced: reconciled,
    });
    registerTallyCommands(stewardGateway);
    const stewardCredential: Credential = {
      kind: "device",
      deviceId: originBoot.deviceId,
      deviceKey: originBoot.deviceKey,
    };
    const group = stewardGateway.invoke(stewardCredential, {
      command: "tally.create_group",
      input: { name: "Trip", icon: "🧳", member_ids: [bob] },
    });
    const groupId = (group as { output: { group_id: string } }).output.group_id;
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "tally.group",
      containerId: groupId,
      members: [
        {
          partyId: bob,
          capability: "read+write",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats: [
        {
          partyId: originBoot.ownerPartyId,
          capability: "read+write",
          vaultId: "vault-priya",
          vault: origin,
        },
        {
          partyId: bob,
          capability: "read+write",
          vaultId: "vault-family",
          vault: audience,
        },
      ],
      now,
    });

    const memberGateway = createGateway(audience);
    registerTallyCommands(memberGateway);
    const memberCredential: Credential = {
      kind: "device",
      deviceId: audienceBoot.deviceId,
      deviceKey: audienceBoot.deviceKey,
    };
    const commandInput = {
      group_id: groupId,
      description: "Lunch",
      amount_minor: 600,
      paid_by: bob,
      category: "food",
      splits: [
        { party_id: originBoot.ownerPartyId, share_minor: 300 },
        { party_id: bob, share_minor: 300 },
      ],
    };
    const queued = memberGateway.invoke(memberCredential, {
      command: "tally.add_expense",
      input: commandInput,
      intentId: "member-intent",
      intentDeviceId: audienceBoot.deviceId,
    });
    expect(queued).toMatchObject({
      status: "denied",
      reason: "waiting for Priya's device",
    });
    expect(
      audience.vault
        .prepare("SELECT COUNT(*) AS n FROM tally_expense WHERE group_id = ?")
        .get(groupId)
    ).toMatchObject({ n: 0 });
    expect(
      audience.vault
        .prepare(
          `SELECT status, steward_label FROM share_commons_intent
            WHERE intent_id = ?`
        )
        .get("member-intent")
    ).toMatchObject({ status: "queued", steward_label: "Priya's device" });

    const inlineApp = enrollApp(audience, { name: "tally-inline" });
    const appWrite = memberGateway.invoke(
      { kind: "app", ...inlineApp },
      {
        command: "tally.add_expense",
        input: commandInput,
      }
    );
    expect(appWrite).toMatchObject({
      status: "denied",
      reason: "waiting for Priya's device",
    });
    expect(
      audience.vault
        .prepare("SELECT COUNT(*) AS n FROM share_commons_intent")
        .get()
    ).toMatchObject({ n: 2 });

    const automationAgent = enrollAgent(audience, {
      name: "tally-automation",
      modelRef: "test-model",
    });
    const automation = memberGateway.invoke(
      {
        kind: "agent",
        agentId: automationAgent.agentId,
        deviceId: audienceBoot.deviceId,
        deviceKey: audienceBoot.deviceKey,
      },
      {
        command: "tally.add_expense",
        input: commandInput,
      }
    );
    expect(automation).toMatchObject({
      status: "denied",
      reason: "commons automations execute only at the steward's seat",
    });
    expect(
      audience.vault
        .prepare("SELECT COUNT(*) AS n FROM share_commons_intent")
        .get()
    ).toMatchObject({ n: 2 });

    const stewardWrite = stewardGateway.invoke(stewardCredential, {
      command: "tally.add_expense",
      input: {
        ...commandInput,
        description: "Train",
        paid_by: originBoot.ownerPartyId,
      },
    });
    expect(stewardWrite.status).toBe("executed");
    expect(
      origin.vault
        .prepare(
          "SELECT actor_party_id, sequence FROM share_commons_op WHERE grant_id = ?"
        )
        .all(grant.grantId)
    ).toMatchObject([{ actor_party_id: originBoot.ownerPartyId, sequence: 1 }]);
    expect(reconciled).toHaveBeenCalledOnce();

    const currentSize = commonsCurrentSize(
      origin.vault,
      "vault-priya",
      grant.grantId
    );
    origin.vault
      .prepare(
        "UPDATE share_circle_grant SET max_size_bytes = ? WHERE grant_id = ?"
      )
      .run(currentSize, grant.grantId);
    const overMax = stewardGateway.invoke(stewardCredential, {
      command: "tally.add_expense",
      input: {
        ...commandInput,
        description: "Crosses maximum",
        paid_by: originBoot.ownerPartyId,
      },
    });
    expect(overMax).toMatchObject({
      status: "denied",
      reason: expect.stringMatching(/above its .* byte maximum/u),
    });
    expect(
      origin.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM tally_expense WHERE description = 'Crosses maximum'"
        )
        .get()
    ).toMatchObject({ n: 0 });
    expect(
      origin.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toMatchObject({ n: 1 });
    expect(reconciled).toHaveBeenCalledOnce();
    origin.vault
      .prepare(
        "UPDATE share_circle_grant SET max_size_bytes = NULL WHERE grant_id = ?"
      )
      .run(grant.grantId);

    const prepare = origin.vault.prepare.bind(origin.vault);
    const failure = vi
      .spyOn(origin.vault, "prepare")
      .mockImplementation((sql: string) => {
        if (sql.includes("INSERT INTO share_commons_op"))
          throw new Error("injected Commons op failure");
        return prepare(sql);
      });
    expect(() =>
      stewardGateway.invoke(stewardCredential, {
        command: "tally.add_expense",
        input: {
          ...commandInput,
          description: "Must roll back",
          paid_by: originBoot.ownerPartyId,
        },
      })
    ).toThrow("injected Commons op failure");
    failure.mockRestore();
    expect(
      origin.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM tally_expense WHERE description = 'Must roll back'"
        )
        .get()
    ).toMatchObject({ n: 0 });
    expect(
      origin.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toMatchObject({ n: 1 });
    expect(reconciled).toHaveBeenCalledOnce();

    const expense = origin.vault
      .prepare(
        "SELECT expense_id FROM tally_expense WHERE group_id = ? AND description = 'Train'"
      )
      .get(groupId) as { expense_id: string };
    expect(
      stewardGateway.invoke(stewardCredential, {
        command: "tally.set_expense_memo",
        input: { expense_id: expense.expense_id, note: "must not be private" },
      })
    ).toMatchObject({
      status: "denied",
      reason: "command tally.set_expense_memo is not declared for tally.group",
    });
    expect(
      origin.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM knowledge_annotation WHERE target_type = 'tally.expense' AND target_id = ?"
        )
        .get(expense.expense_id)
    ).toMatchObject({ n: 0 });
    expect(
      origin.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ?"
        )
        .get(grant.grantId)
    ).toMatchObject({ n: 1 });
    expect(reconciled).toHaveBeenCalledOnce();
  });
});
