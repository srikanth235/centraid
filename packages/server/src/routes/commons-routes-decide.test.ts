import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import { createCommonsGrant, registerTallyCommands } from "@centraid/vault";

import { addKnownParty } from "../serve/commons-b6.test-fixtures.js";
import { EnrollmentStore } from "../serve/enrollment-store.js";
import { makeCoHostedSides } from "../serve/peer-give.test-fixtures.js";
import { COMMONS_PATH, makeCommonsRouteHandler } from "./commons-routes.js";

const closers: Array<() => Promise<void>> = [];

async function decideWorld(name: string) {
  const [steward, member] = makeCoHostedSides(name, "steward", "member");
  const now = new Date().toISOString();
  addKnownParty(steward, member, now);
  registerTallyCommands(steward.gateway);
  const created = steward.gateway.invoke(steward.ownerCredential, {
    command: "tally.create_group",
    input: { name: "Goa", icon: "🏖️", member_ids: [member.ownerPartyId] },
  });
  expect(created.status).toBe("executed");
  const groupId = (created as { output: { group_id: string } }).output.group_id;
  const grant = createCommonsGrant({
    origin: steward.vault.vault,
    ownerPartyId: steward.ownerPartyId,
    ownerVaultId: steward.vaultId,
    ownerVault: steward.vault,
    containerType: "tally.group",
    containerId: groupId,
    members: [
      {
        partyId: member.ownerPartyId,
        capability: "read+write",
        vaultId: member.vaultId,
        vault: member.vault,
      },
    ],
    now,
  });
  const sides = new Map([
    [steward.vaultId, steward],
    [member.vaultId, member],
  ]);
  const handler = makeCommonsRouteHandler({
    enrollments: EnrollmentStore.open(steward.gatewayDb),
    vaultFor: (vaultId) => sides.get(vaultId)?.vault,
    ownerPartyFor: (vaultId) => sides.get(vaultId)?.ownerPartyId,
    gatewayFor: (vaultId) => sides.get(vaultId)?.gateway,
    credentialFor: (vaultId) => sides.get(vaultId)?.ownerCredential,
  });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      })
  );
  const post = (path: string, deviceId: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: deviceId,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const park = async (intentId: string, description: string) => {
    const queued = await post(
      `${COMMONS_PATH}/${grant.grantId}/commands`,
      member.deviceId,
      {
        originVaultId: "vlt_unreachable",
        actorVaultId: member.vaultId,
        command: "tally.add_expense",
        input: {
          group_id: groupId,
          description,
          amount_minor: 1000,
          paid_by: member.ownerPartyId,
          category: "food",
          splits: [
            { party_id: steward.ownerPartyId, share_minor: 500 },
            { party_id: member.ownerPartyId, share_minor: 500 },
          ],
        },
        intentId,
      }
    );
    expect(queued.status).toBe(202);
    return queued;
  };
  const decide = (
    deviceId: string,
    actorVaultId: string,
    intentId: string,
    body: Record<string, unknown>
  ) =>
    post(
      `${COMMONS_PATH}/intents/${encodeURIComponent(intentId)}/decide`,
      deviceId,
      { actorVaultId, ...body }
    );
  const intentStatus = (intentId: string) =>
    member.vault.vault
      .prepare(
        "SELECT status, reason FROM share_commons_intent WHERE intent_id = ?"
      )
      .get(intentId) as { status: string; reason: string | null } | undefined;
  return { steward, member, groupId, grant, park, decide, intentStatus };
}

describe("Commons intent decide route (issue #872)", () => {
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  test("the steward approves a parked member command and it lands through the rail", async () => {
    const world = await decideWorld("commons-decide-approve");
    await world.park("decide-approve", "Named by the member");

    const approved = await world.decide(
      world.steward.deviceId,
      world.steward.vaultId,
      "decide-approve",
      { decision: "approve" }
    );

    expect(approved.status).toBe(200);
    const body = (await approved.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      intentId: "decide-approve",
      grantId: world.grant.grantId,
      decision: "approve",
      decided: true,
      status: "executed",
    });
    expect(body.receiptId).toBeTypeOf("string");
    expect(world.intentStatus("decide-approve")).toMatchObject({
      status: "executed",
    });
    expect(
      world.steward.vault.vault
        .prepare(
          "SELECT paid_by FROM tally_expense WHERE group_id = ? AND description = ?"
        )
        .get(world.groupId, "Named by the member")
    ).toMatchObject({ paid_by: world.member.ownerPartyId });
  });

  test("the steward declines with words the member reads back verbatim", async () => {
    const world = await decideWorld("commons-decide-decline");
    await world.park("decide-decline", "Not this title");

    const declined = await world.decide(
      world.steward.deviceId,
      world.steward.vaultId,
      "decide-decline",
      { decision: "decline", reason: "we agreed to keep the original caption" }
    );

    expect(declined.status).toBe(200);
    await expect(declined.json()).resolves.toMatchObject({
      decision: "decline",
      decided: true,
      status: "denied",
      reason: "we agreed to keep the original caption",
    });
    expect(world.intentStatus("decide-decline")).toMatchObject({
      status: "denied",
      reason: "we agreed to keep the original caption",
    });
  });

  test("a member cannot decide, even from their own seat", async () => {
    const world = await decideWorld("commons-decide-authz");
    await world.park("decide-authz", "Member's own call");

    const refused = await world.decide(
      world.member.deviceId,
      world.member.vaultId,
      "decide-authz",
      { decision: "approve" }
    );

    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      error: "invalid_commons",
      message: expect.stringContaining("only the commons steward"),
    });
    expect(world.intentStatus("decide-authz")).toMatchObject({
      status: "parked",
    });
  });

  test("a caller who does not own the deciding vault gets nowhere", async () => {
    const world = await decideWorld("commons-decide-owner");
    await world.park("decide-owner", "Someone else's vault");

    const refused = await world.decide(
      world.member.deviceId,
      world.steward.vaultId,
      "decide-owner",
      { decision: "approve" }
    );

    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      message: "actor vault is not owned by this caller",
    });
  });

  test("a decision that is not approve or decline is refused before anything is read", async () => {
    const world = await decideWorld("commons-decide-verb");
    await world.park("decide-verb", "Sideways verb");

    const refused = await world.decide(
      world.steward.deviceId,
      world.steward.vaultId,
      "decide-verb",
      { decision: "maybe" }
    );

    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      message: "decision must be approve or decline",
    });
    expect(world.intentStatus("decide-verb")).toMatchObject({
      status: "parked",
    });
  });

  test("an intent no seat holds is named, not silently accepted", async () => {
    const world = await decideWorld("commons-decide-unknown");

    const refused = await world.decide(
      world.steward.deviceId,
      world.steward.vaultId,
      "no-such-intent",
      { decision: "decline" }
    );

    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      message: "commons intent no-such-intent is not available",
    });
  });
});
