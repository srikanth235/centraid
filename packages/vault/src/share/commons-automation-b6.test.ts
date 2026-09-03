import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { bootstrapVault, createGrant, enrollAgent } from "../bootstrap.js";
import { registerTallyCommands } from "../commands/tally.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso } from "../ids.js";
import { commonsSeats } from "./commons-lifecycle.js";
import { compileCommons, createCommonsGrant } from "./commons.js";

interface Seat {
  vaultId: string;
  db: VaultDb;
  ownerPartyId: string;
  automation: Credential;
}

const opened: VaultDb[] = [];
const roots: string[] = [];

function openSeat(root: string, vaultId: string, name: string): Seat {
  const dir = path.join(root, vaultId);
  mkdirSync(dir, { recursive: true });
  const db = openVaultDb({ dir });
  opened.push(db);
  const boot = bootstrapVault(db, { vaultId, ownerName: name });
  const agent = enrollAgent(db, {
    name: "tally-commons-writer",
    modelRef: "centraid-automation",
  });
  createGrant(db, {
    granteePartyId: agent.partyId,
    purposeConceptId: boot.concepts["dpv:ServiceProvision"] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: "tally", verbs: "act" }],
  });
  return {
    vaultId,
    db,
    ownerPartyId: boot.ownerPartyId,
    automation: {
      kind: "agent",
      agentId: agent.agentId,
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    },
  };
}

describe("B6 Commons-writing automation ownership", () => {
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close();
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  test("the same automation event mutates once at the steward, never once per resident seat", () => {
    const root = tempDirSync("commons-b6-automation-");
    roots.push(root);
    const steward = openSeat(root, "vault-steward", "Priya");
    const bob = openSeat(root, "vault-bob", "Bob");
    const cara = openSeat(root, "vault-cara", "Cara");
    const now = nowIso();

    for (const member of [bob, cara])
      steward.db.vault
        .prepare(
          `INSERT INTO core_party
             (party_id, kind, display_name, sort_name, birth_date,
              avatar_content_id, created_at, updated_at)
           VALUES (?, 'person', ?, ?, NULL, NULL, ?, ?)`
        )
        .run(
          member.ownerPartyId,
          member.ownerPartyId,
          member.ownerPartyId,
          now,
          now
        );

    const gateways = [steward, bob, cara].map((seat) => {
      const gateway = createGateway(seat.db);
      registerTallyCommands(gateway);
      return { seat, gateway };
    });
    const owner = bootstrapCredential(steward.db);
    const created = gateways[0]!.gateway.invoke(owner, {
      command: "tally.create_group",
      input: {
        name: "Household",
        icon: "🏠",
        member_ids: [bob.ownerPartyId, cara.ownerPartyId],
      },
    });
    expect(created.status).toBe("executed");
    const groupId = (created as { output: { group_id: string } }).output
      .group_id;
    const grant = createCommonsGrant({
      origin: steward.db.vault,
      ownerPartyId: steward.ownerPartyId,
      ownerVaultId: steward.vaultId,
      ownerVault: steward.db,
      containerType: "tally.group",
      containerId: groupId,
      members: [bob, cara].map((member) => ({
        partyId: member.ownerPartyId,
        capability: "read+write" as const,
        vaultId: member.vaultId,
        vault: member.db,
      })),
      now,
    });
    const vaultFor = (vaultId: string) =>
      [steward, bob, cara].find((seat) => seat.vaultId === vaultId)?.db;
    const reconcile = () =>
      compileCommons({
        steward: steward.db,
        stewardVaultId: steward.vaultId,
        grantId: grant.grantId,
        seats: commonsSeats({
          steward: steward.db.vault,
          grantId: grant.grantId,
          stewardVaultId: steward.vaultId,
          vaultFor,
        }),
        now,
      });
    reconcile();

    const command = {
      command: "tally.add_expense",
      input: {
        group_id: groupId,
        description: "One household event",
        amount_minor: 900,
        paid_by: steward.ownerPartyId,
        category: "general",
        splits: [steward, bob, cara].map((seat) => ({
          party_id: seat.ownerPartyId,
          share_minor: 300,
        })),
      },
    };
    const outcomes = gateways.map(({ seat, gateway }) =>
      gateway.invoke(seat.automation, {
        command: command.command,
        input: structuredClone(command.input),
      })
    );
    if (outcomes[0]?.status !== "executed")
      throw new Error(JSON.stringify(outcomes[0]));
    expect(outcomes[0]).toMatchObject({ status: "executed" });
    expect(outcomes.slice(1)).toStrictEqual([
      expect.objectContaining({
        status: "denied",
        reason: "commons automations execute only at the steward's seat",
      }),
      expect.objectContaining({
        status: "denied",
        reason: "commons automations execute only at the steward's seat",
      }),
    ]);
    reconcile();

    expect(
      steward.db.vault
        .prepare(
          "SELECT actor_party_id, command, outcome FROM share_commons_op WHERE grant_id = ?"
        )
        .all(grant.grantId)
    ).toMatchObject([
      {
        actor_party_id: steward.ownerPartyId,
        command: "tally.add_expense",
        outcome: "executed",
      },
    ]);
    for (const seat of [steward, bob, cara])
      expect(
        seat.db.vault
          .prepare("SELECT COUNT(*) AS n FROM tally_expense WHERE group_id = ?")
          .get(groupId)
      ).toMatchObject({ n: 1 });
  });
});

function bootstrapCredential(db: VaultDb): Credential {
  const row = db.vault
    .prepare(
      `SELECT d.device_id, d.public_key
         FROM access_device d
         JOIN core_vault v ON v.self_party_id = d.owner_party_id
        LIMIT 1`
    )
    .get() as { device_id: string; public_key: string };
  return { kind: "device", deviceId: row.device_id, deviceKey: row.public_key };
}
