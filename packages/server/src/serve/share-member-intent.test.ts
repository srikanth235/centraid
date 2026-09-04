/*
 * A MEMBER'S WRITE IS A SIGNED REPLICA INTENT (#929, wave 3).
 *
 * What this holds, on the golden pair:
 *   - the ORIGIN executes it as the single writer, and the receipt names the
 *     MEMBER rather than the credential that carried it;
 *   - a container shared for view refuses BY NAME, so nothing lands privately;
 *   - a forged signature is refused with a reason, not a 404 — the peer is
 *     linked and has to be told what to fix;
 *   - the answer carries the ORIGIN row versions it stands for (G1).
 */

import { describe, expect, test, vi } from "vitest";

import { PEER_REPLICA_INTENTS_PATH } from "@centraid/core/protocol";
import {
  createShareGrant,
  nowIso,
  signMemberIntent,
  uuidv7,
} from "@centraid/vault";
import type { MemberIntentEnvelope } from "@centraid/vault";

import { link, makeSide } from "./peer-give.test-fixtures.js";
import type { Side } from "./peer-give.test-fixtures.js";
import type { PeerRequest } from "./peer-link-client.js";
import {
  addAudienceParty,
  addLocalParty,
  seedEverySubject,
  wireGoldenPair,
} from "./share-subscription-peer.test-fixtures.js";

vi.setConfig({ testTimeout: 60_000 });

function shapeIdFor(grantId: string): string {
  return `@share:${grantId}`;
}

function envelopeFor(
  origin: Side,
  member: Side,
  grantId: string,
  input: Record<string, unknown>,
  action = "tally.add_expense"
): MemberIntentEnvelope {
  return {
    intentId: uuidv7(),
    shapeId: shapeIdFor(grantId),
    originVaultId: origin.vaultId,
    memberVaultId: member.vaultId,
    appId: "tally",
    action,
    input,
  };
}

/** The origin's peer plane with the write door mounted. */
function originDial(origin: Side, member: Side): { request: PeerRequest } {
  return { request: wireGoldenPair(origin, member).toOrigin.request };
}

describe("a member's write to a shared container", () => {
  test("is executed by the origin and receipted naming the member", async () => {
    const origin = makeSide("mi-origin");
    const member = makeSide("mi-member");
    await link(origin, member);
    const memberParty = addAudienceParty(origin, member);
    const subjects = seedEverySubject(origin, memberParty);
    const group = subjects.find(
      (subject) => subject.subjectType === "tally.group"
    )!;
    const grant = createShareGrant(origin.vault.vault, {
      audience: { kind: "party", id: memberParty },
      subjectType: "tally.group",
      subjectId: group.subjectId,
      capability: "edit",
      grantedAt: nowIso(),
      grantedBy: origin.ownerPartyId,
    });
    const dial = originDial(origin, member);
    const envelope = envelopeFor(origin, member, grant.grantId, {
      group_id: group.subjectId,
      description: "Taxi",
      amount_minor: 1200,
      category: "transport",
      paid_by: origin.ownerPartyId,
      splits: [
        { party_id: origin.ownerPartyId, share_minor: 600 },
        { party_id: memberParty, share_minor: 600 },
      ],
    });

    const response = await dial.request({
      endpointTicket: "ticket",
      method: "POST",
      target: PEER_REPLICA_INTENTS_PATH,
      body: {
        ...envelope,
        signature: signMemberIntent(member.vault.identitySeed, envelope),
      },
    });
    const body = response.json as { state: string; answeredVersions?: unknown };
    expect(
      [response.status, body.state],
      JSON.stringify(response.json)
    ).toStrictEqual([200, "executed"]);
    // ONE WRITER: the row is in the ORIGIN's vault, not the member's.
    expect(
      origin.vault.vault
        .prepare("SELECT count(*) AS n FROM tally_expense WHERE group_id = ?")
        .get(group.subjectId)
    ).toMatchObject({ n: 1 });
    expect(
      member.vault.vault
        .prepare("SELECT count(*) AS n FROM tally_expense")
        .get()
    ).toMatchObject({ n: 0 });
    // The answer names the ORIGIN versions it stands for (G1).
    expect(Array.isArray(body.answeredVersions)).toBe(true);

    // THE RECEIPT NAMES THE MEMBER, not the owner credential that executed it.
    const receipt = origin.vault.audit
      .prepare(
        `SELECT detail_json FROM access_receipt
          WHERE object_type = 'tally.group' AND object_id = ?
          ORDER BY rowid DESC LIMIT 1`
      )
      .get(group.subjectId) as { detail_json: string } | undefined;
    expect(receipt).toBeTruthy();
    const detail = JSON.parse(receipt!.detail_json) as {
      memberVaultId: string;
      memberLabel: string;
      intentId: string;
    };
    expect(detail.memberVaultId).toBe(member.vaultId);
    expect(detail.memberLabel).toBe(member.label);
    expect(detail.intentId).toBe(envelope.intentId);

    origin.vault.close();
    member.vault.close();
  });

  test("refuses a view-only container by name, and a forged signature with a reason", async () => {
    const origin = makeSide("mi-refuse-origin");
    const member = makeSide("mi-refuse-member");
    await link(origin, member);
    const memberParty = addAudienceParty(origin, member);
    const subjects = seedEverySubject(
      origin,
      addLocalParty(origin, "Ledger member")
    );
    const group = subjects.find(
      (subject) => subject.subjectType === "tally.group"
    )!;
    const grant = createShareGrant(origin.vault.vault, {
      audience: { kind: "party", id: memberParty },
      subjectType: "tally.group",
      subjectId: group.subjectId,
      capability: "view",
      grantedAt: nowIso(),
      grantedBy: origin.ownerPartyId,
    });
    const dial = originDial(origin, member);
    const envelope = envelopeFor(origin, member, grant.grantId, {
      group_id: group.subjectId,
      description: "Taxi",
      amount_minor: 1200,
      category: "transport",
      paid_by: origin.ownerPartyId,
      splits: [
        { party_id: origin.ownerPartyId, share_minor: 600 },
        { party_id: memberParty, share_minor: 600 },
      ],
    });

    const denied = await dial.request({
      endpointTicket: "ticket",
      method: "POST",
      target: PEER_REPLICA_INTENTS_PATH,
      body: {
        ...envelope,
        signature: signMemberIntent(member.vault.identitySeed, envelope),
      },
    });
    expect(denied.json).toMatchObject({
      state: "denied",
      reason: `tally.add_expense writes into tally.group ${group.subjectId}, which is shared for view only`,
    });
    expect(
      origin.vault.vault
        .prepare("SELECT count(*) AS n FROM tally_expense")
        .get()
    ).toMatchObject({ n: 0 });

    // A signature by the WRONG vault is attribution failing, not admission:
    // the peer is linked and needs to know what to fix.
    const forged = await dial.request({
      endpointTicket: "ticket",
      method: "POST",
      target: PEER_REPLICA_INTENTS_PATH,
      body: {
        ...envelope,
        signature: signMemberIntent(origin.vault.identitySeed, envelope),
      },
    });
    expect(forged.status).toBe(403);
    expect(forged.json).toMatchObject({ state: "refused" });

    origin.vault.close();
    member.vault.close();
  });

  /**
   * A CONFIRMATION-GATED WRITE PARKS, and the answer says WHO it waits on with
   * the label from the link — so the member's seat renders a person deciding,
   * not a vault id and a shrug.
   */
  test("parks a confirmation-gated write and names who it waits on", async () => {
    const origin = makeSide("mi-park-origin");
    const member = makeSide("mi-park-member");
    await link(origin, member);
    const memberParty = addAudienceParty(origin, member);
    const subjects = seedEverySubject(origin, memberParty);
    const group = subjects.find(
      (subject) => subject.subjectType === "tally.group"
    )!;
    const grant = createShareGrant(origin.vault.vault, {
      audience: { kind: "party", id: memberParty },
      subjectType: "tally.group",
      subjectId: group.subjectId,
      capability: "edit",
      grantedAt: nowIso(),
      grantedBy: origin.ownerPartyId,
    });
    const dial = originDial(origin, member);
    // The owner's own gate, armed AFTER the command pack registered its
    // capability rows: the command now needs a confirmation the peer plane
    // cannot supply, so the write parks for the owner to decide.
    origin.vault.vault
      .prepare(
        `UPDATE agent_capability SET requires_confirmation = 1
          WHERE command_id =
            (SELECT command_id FROM agent_command WHERE name = ?)`
      )
      .run("tally.add_expense");
    const envelope = envelopeFor(origin, member, grant.grantId, {
      group_id: group.subjectId,
      description: "Taxi",
      amount_minor: 1200,
      category: "transport",
      paid_by: origin.ownerPartyId,
      splits: [
        { party_id: origin.ownerPartyId, share_minor: 600 },
        { party_id: memberParty, share_minor: 600 },
      ],
    });

    const parked = await dial.request({
      endpointTicket: "ticket",
      method: "POST",
      target: PEER_REPLICA_INTENTS_PATH,
      body: {
        ...envelope,
        signature: signMemberIntent(member.vault.identitySeed, envelope),
      },
    });
    expect(
      [parked.status, (parked.json as { state: string }).state],
      JSON.stringify(parked.json)
    ).toStrictEqual([202, "parked"]);
    expect(parked.json).toMatchObject({
      waitingOn: { seat: "owner", label: origin.label },
    });
    // Nothing landed while it waits: the origin is the single writer, and it
    // has not written.
    expect(
      origin.vault.vault
        .prepare("SELECT count(*) AS n FROM tally_expense")
        .get()
    ).toMatchObject({ n: 0 });

    origin.vault.close();
    member.vault.close();
  });
});
