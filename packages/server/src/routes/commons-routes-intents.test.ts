// Split from commons-routes.test.ts to stay under the repo's file-size limit
// (#615). Covers issue #731's gateway plumbing for the two goals vault-side
// work left undone: goal 1 (the command route carries `based_on_sequence`
// into `executeCommonsCommand`) and goal 2 (the intent cancel route).
import http from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import {
  createCommonsGrant,
  registerTallyCommands,
  STALE_CONTEXT_REASON_PREFIX,
} from "@centraid/vault";

import { addKnownParty } from "../serve/commons-b6.test-fixtures.js";
import { EnrollmentStore } from "../serve/enrollment-store.js";
import {
  makeCoHostedSides,
  seedPhoto,
} from "../serve/peer-give.test-fixtures.js";
import { COMMONS_PATH, makeCommonsRouteHandler } from "./commons-routes.js";

describe("Commons command route carries based_on_sequence (issue #731 goal 1)", () => {
  test("the command route reads back queueCommonsIntent's recorded based_on_sequence and forwards it into execution", async () => {
    const [steward, member] = makeCoHostedSides(
      "commons-based-on-sequence",
      "steward",
      "member"
    );
    const now = new Date().toISOString();
    addKnownParty(steward, member, now);
    registerTallyCommands(steward.gateway);
    const created = steward.gateway.invoke(steward.ownerCredential, {
      command: "tally.create_group",
      input: {
        name: "Based-on-sequence household",
        icon: "🧭",
        member_ids: [member.ownerPartyId],
      },
    });
    expect(created.status).toBe("executed");
    const groupId = (created as { output: { group_id: string } }).output
      .group_id;
    const grant = createCommonsGrant({
      origin: steward.vault.vault,
      ownerPartyId: steward.ownerPartyId,
      ownerVaultId: steward.vaultId,
      ownerVault: steward.vault,
      containerType: "tally.group",
      containerId: groupId,
      // Deliberately no vaultId here: giving the member one would also mark
      // its seat "current" (`createCommonsGrant`'s own coupling), and a
      // "current" seat gets reconciled by every steward-side compile below —
      // which would keep the member's local grant caught up and defeat the
      // scenario. The member is registered read+write and gets its signing
      // binding inserted directly below, but its seat stays "invited" so it
      // never locally compiles this grant — the honest, unobserved-history
      // baseline `queueCommonsIntent` records for it is 0.
      members: [{ partyId: member.ownerPartyId, capability: "read+write" }],
      now,
    });
    // The member's vault signing identity, bound at the steward without
    // going through `createCommonsGrant`'s vaultId path (see above).
    steward.vault.vault
      .prepare(
        `INSERT INTO share_party_vault_binding
           (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`
      )
      .run(
        "based-on-sequence-binding",
        member.ownerPartyId,
        member.vaultId,
        member.publicKey,
        now
      );
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
    const sendCommand = (
      actor: typeof steward,
      command: string,
      input: Record<string, unknown>,
      intentId: string
    ) =>
      fetch(
        `http://127.0.0.1:${port}${COMMONS_PATH}/${grant.grantId}/commands`,
        {
          method: "POST",
          headers: {
            [AUTHED_DEVICE_HEADER]: actor.deviceId,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            originVaultId: steward.vaultId,
            actorVaultId: actor.vaultId,
            command,
            input,
            intentId,
          }),
        }
      );
    try {
      const splits = [
        { party_id: steward.ownerPartyId, share_minor: 450 },
        { party_id: member.ownerPartyId, share_minor: 450 },
      ];
      const added = await sendCommand(
        steward,
        "tally.add_expense",
        {
          group_id: groupId,
          description: "Ferry",
          amount_minor: 900,
          paid_by: steward.ownerPartyId,
          category: "travel",
          splits,
        },
        "based-on-sequence-add"
      );
      expect(added.status).toBe(200);
      const expenseId = (
        steward.vault.vault
          .prepare(
            "SELECT expense_id FROM tally_expense WHERE group_id = ? AND description = 'Ferry'"
          )
          .get(groupId) as { expense_id: string }
      ).expense_id;

      // A steward-side edit to the SAME expense is the intervening op the
      // member's (unobserved) mental model missed.
      const edited = await sendCommand(
        steward,
        "tally.edit_expense",
        {
          expense_id: expenseId,
          description: "Ferry (updated)",
          amount_minor: 900,
          paid_by: steward.ownerPartyId,
          category: "travel",
          splits,
        },
        "based-on-sequence-edit"
      );
      expect(edited.status).toBe(200);

      // The member's own edit of the SAME expense names based_on_sequence 0,
      // strictly behind the steward's edit above. If the route failed to
      // carry the recorded value into `executeCommonsCommand`, this would
      // simply execute; carrying it correctly refuses it as a stale-context
      // conflict instead.
      const conflicting = await sendCommand(
        member,
        "tally.edit_expense",
        {
          expense_id: expenseId,
          description: "Ferry (member's version)",
          amount_minor: 900,
          paid_by: member.ownerPartyId,
          category: "travel",
          splits,
        },
        "based-on-sequence-conflict"
      );
      expect(conflicting.status).toBe(403);
      const conflictingBody = (await conflicting.json()) as {
        decision: { accepted: boolean; reason?: string };
      };
      expect(conflictingBody.decision.accepted).toBe(false);
      expect(conflictingBody.decision.reason).toStrictEqual(
        expect.stringContaining(STALE_CONTEXT_REASON_PREFIX)
      );

      expect(
        member.vault.vault
          .prepare(
            "SELECT based_on_sequence, status FROM share_commons_intent WHERE intent_id = ?"
          )
          .get("based-on-sequence-conflict")
      ).toMatchObject({ based_on_sequence: 0, status: "denied" });

      // The refusal never touched the domain row.
      expect(
        steward.vault.vault
          .prepare("SELECT description FROM tally_expense WHERE expense_id = ?")
          .get(expenseId)
      ).toMatchObject({ description: "Ferry (updated)" });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});

describe("Commons intent cancel route (issue #731 goal 2)", () => {
  test("cancelling a still-open intent returns the client's expected shape and settles the row", async () => {
    const [steward, member] = makeCoHostedSides(
      "commons-cancel-route",
      "steward",
      "member"
    );
    const now = new Date().toISOString();
    const photo = seedPhoto(steward, "cancel-route");
    const grant = createCommonsGrant({
      origin: steward.vault.vault,
      ownerPartyId: steward.ownerPartyId,
      ownerVaultId: steward.vaultId,
      ownerVault: steward.vault,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [{ partyId: member.ownerPartyId, capability: "read+write" }],
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
      // Neither resolves for the steward: the intent parks instead of
      // executing, so it stays cancellable.
      gatewayFor: () => undefined,
      credentialFor: () => undefined,
    });
    const server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const queued = await fetch(
        `http://127.0.0.1:${port}${COMMONS_PATH}/${grant.grantId}/commands`,
        {
          method: "POST",
          headers: {
            [AUTHED_DEVICE_HEADER]: member.deviceId,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            originVaultId: steward.vaultId,
            actorVaultId: member.vaultId,
            command: "media.update_asset",
            input: { asset_id: photo.assetId, title: "queued while parked" },
            intentId: "cancel-route-intent",
          }),
        }
      );
      expect(queued.status).toBe(202);
      await expect(queued.json()).resolves.toMatchObject({
        status: "parked",
      });

      const cancelled = await fetch(
        `http://127.0.0.1:${port}${COMMONS_PATH}/intents/${encodeURIComponent(
          "cancel-route-intent"
        )}/cancel`,
        {
          method: "POST",
          headers: {
            [AUTHED_DEVICE_HEADER]: member.deviceId,
            "content-type": "application/json",
          },
          body: JSON.stringify({ actorVaultId: member.vaultId }),
        }
      );
      expect(cancelled.status).toBe(200);
      await expect(cancelled.json()).resolves.toStrictEqual({
        status: "cancelled",
        cancelled: true,
      });
      expect(
        member.vault.vault
          .prepare(
            "SELECT status FROM share_commons_intent WHERE intent_id = ?"
          )
          .get("cancel-route-intent")
      ).toMatchObject({ status: "cancelled" });

      // A second cancel of the SAME already-cancelled intent is idempotent.
      const repeat = await fetch(
        `http://127.0.0.1:${port}${COMMONS_PATH}/intents/${encodeURIComponent(
          "cancel-route-intent"
        )}/cancel`,
        {
          method: "POST",
          headers: {
            [AUTHED_DEVICE_HEADER]: member.deviceId,
            "content-type": "application/json",
          },
          body: JSON.stringify({ actorVaultId: member.vaultId }),
        }
      );
      expect(repeat.status).toBe(200);
      await expect(repeat.json()).resolves.toStrictEqual({
        status: "cancelled",
        cancelled: true,
      });

      // A genuine race: the steward's real answer already settled this
      // intent to a DIFFERENT terminal state before the member's cancel
      // arrived. Cancel must never override that outcome — it reports the
      // true status and `cancelled: false`, matching the documented race
      // contract on `cancelCommonsIntent` (the WHERE clause only ever moves
      // a still-open `pending`/`parked` row).
      member.vault.vault
        .prepare(
          `INSERT INTO share_commons_intent
             (intent_id, grant_id, actor_party_id, command, input_json,
              based_on_sequence, status, reason, steward_label, created_at, settled_at)
           VALUES ('race-intent', ?, ?, 'media.update_asset', '{}', 0, 'executed', NULL, NULL, ?, ?)`
        )
        .run(grant.grantId, member.ownerPartyId, now, now);
      const lostRace = await fetch(
        `http://127.0.0.1:${port}${COMMONS_PATH}/intents/race-intent/cancel`,
        {
          method: "POST",
          headers: {
            [AUTHED_DEVICE_HEADER]: member.deviceId,
            "content-type": "application/json",
          },
          body: JSON.stringify({ actorVaultId: member.vaultId }),
        }
      );
      expect(lostRace.status).toBe(200);
      await expect(lostRace.json()).resolves.toStrictEqual({
        status: "executed",
        cancelled: false,
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
