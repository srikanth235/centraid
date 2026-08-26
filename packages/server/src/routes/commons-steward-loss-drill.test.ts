/**
 * The steward-absence DRILL (#750): the whole path an operator walks in
 * docs/recovery/commons-steward-loss.md, end to end, over the in-process
 * transport — absence evidence recorded → a notice surfaces → the ceremony
 * runs → successor invitations are actually delivered → a member converges on
 * the successor group.
 *
 * Three seats on purpose: N=2 hides the hard case. Here one member is
 * co-hosted with the recovering seat, one is reachable over a peer link, and
 * one has no link to the successor at all (its only link was to the vault that
 * disappeared) — the case that ends in an out-of-band claim ticket.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import {
  answerCommonsInvitation,
  commonsSeats,
  compileCommons,
  createCommonsGrant,
  listCommonsGrants,
  listCommonsInvitations,
  readCommonsGrant,
  upsertCommonsMember,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import {
  COMMONS_ABSENCE_NOTICE_KIND,
  raiseCommonsNotices,
} from "../serve/commons-notices.js";
import { COMMONS_STEWARD_ABSENT_AFTER_MS } from "../serve/commons-observability.js";
import { EnrollmentStore } from "../serve/enrollment-store.js";
import { NoticeStore } from "../serve/notices.js";
import { makeSide, seedPhoto } from "../serve/peer-give.test-fixtures.js";
import type { Side } from "../serve/peer-give.test-fixtures.js";
import {
  COMMONS_RECOVERY_PATH,
  makeCommonsRecoveryRouteHandler,
} from "./commons-recovery-routes.js";

const servers: http.Server[] = [];

interface Drill {
  steward: Side;
  ana: Side;
  bo: Side;
  cy: Side;
  grantId: string;
}

/** One commons, one steward, three members — all four seats co-hosted for the
 *  founding compile, which is what gives every member a full replica. */
function drill(label: string): Drill {
  const steward = makeSide(`${label}-steward`);
  const ana = makeSide(`${label}-ana`);
  const bo = makeSide(`${label}-bo`);
  const cy = makeSide(`${label}-cy`);
  const now = new Date().toISOString();
  const photo = seedPhoto(steward, label);
  const grant = createCommonsGrant({
    origin: steward.vault.vault,
    ownerPartyId: steward.ownerPartyId,
    ownerVaultId: steward.vaultId,
    ownerVault: steward.vault,
    containerType: "media.asset",
    containerId: photo.assetId,
    members: [ana, bo, cy].map((side) => ({
      partyId: side.ownerPartyId,
      capability: "read+write" as const,
      vaultId: side.vaultId,
      vault: side.vault,
      vaultPublicKey: side.publicKey,
    })),
    now,
  });
  const all = [steward, ana, bo, cy];
  compileCommons({
    steward: steward.vault,
    stewardVaultId: steward.vaultId,
    grantId: grant.grantId,
    seats: commonsSeats({
      steward: steward.vault.vault,
      grantId: grant.grantId,
      stewardVaultId: steward.vaultId,
      vaultFor: (vaultId) =>
        all.find((side) => side.vaultId === vaultId)?.vault,
    }),
    now,
  });
  return { steward, ana, bo, cy, grantId: grant.grantId };
}

/** A week of failed pulls with a working local link — the exact evidence the
 *  member's own pull path records, written here without a network. */
function recordAbsence(member: Side, grantId: string, stewardVaultId: string) {
  const now = Date.now();
  const silentSince = new Date(
    now - COMMONS_STEWARD_ABSENT_AFTER_MS - 60_000
  ).toISOString();
  member.vault.vault
    .prepare(
      `INSERT INTO share_commons_steward_contact
         (grant_id, member_vault_id, steward_vault_id, last_contact_at,
          last_attempt_at, absence_since, consecutive_failures, last_outcome,
          attempts, contacts, pull_unreachable, absence_episodes)
       VALUES (?, ?, ?, ?, ?, ?, 12, 'unreachable', 13, 1, 12, 1)`
    )
    .run(
      grantId,
      member.vaultId,
      stewardVaultId,
      silentSince,
      new Date(now - 60_000).toISOString(),
      silentSince
    );
  member.vault.vault
    .prepare(
      `INSERT INTO share_commons_device_reach
         (row_id, last_round_trip_at, round_trips, updated_at)
       VALUES (1, ?, 40, ?)
       ON CONFLICT(row_id) DO UPDATE SET last_round_trip_at = excluded.last_round_trip_at`
    )
    .run(new Date(now - 60_000).toISOString(), new Date(now).toISOString());
}

function serve(
  member: Side,
  cohosted: readonly Side[],
  invited: string[]
): Promise<string> {
  const handler = makeCommonsRecoveryRouteHandler({
    enrollments: EnrollmentStore.open(member.gatewayDb),
    vaultFor: (vaultId): VaultDb | undefined =>
      [member, ...cohosted].find((side) => side.vaultId === vaultId)?.vault,
    // The peer plane, stubbed at exactly the seam production uses: a linked
    // peer accepts the push, an unlinked one is not reachable at all.
    invitePeer: async (invitation) => {
      if (!invited.includes(invitation.memberVaultId)) return false;
      return true;
    },
  });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((owned) => {
      if (!owned) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("steward-loss drill", () => {
  afterEach(() => {
    while (servers.length > 0) servers.pop()?.close();
  });

  test("absence evidence raises a notice, and the ceremony delivers successor invitations", async () => {
    const { steward, ana, bo, cy, grantId } = drill("loss");
    recordAbsence(ana, grantId, steward.vaultId);

    // 1. DETECT — the recorded evidence becomes a card the owner can see.
    const raised = raiseCommonsNotices({
      db: ana.vault,
      vaultId: ana.vaultId,
    });
    expect(raised.map((notice) => notice.kind)).toContain(
      COMMONS_ABSENCE_NOTICE_KIND
    );
    const card = new NoticeStore(ana.vault.vault).getBySource(
      COMMONS_ABSENCE_NOTICE_KIND,
      grantId
    );
    expect(card?.severity).toBe("high");
    expect(card?.detail["recoverable"]).toBe(true);
    // Idempotent: an unchanged condition does not re-raise the same card.
    expect(
      raiseCommonsNotices({ db: ana.vault, vaultId: ana.vaultId })
    ).toStrictEqual([]);

    // 2. RUN THE CEREMONY — Ana re-founds from her replica. Bo is co-hosted
    // with her, Cy is linked to the successor, the old steward is not.
    const url = await serve(ana, [bo], [cy.vaultId]);
    const res = await fetch(`${url}${COMMONS_RECOVERY_PATH}`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: ana.deviceId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ actorVaultId: ana.vaultId, grantId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      grantId: string;
      invitations: {
        partyId: string;
        memberVaultId?: string;
        state: string;
        claimToken?: string;
      }[];
    };
    expect(body.state).toBe("recovered");

    // 3. DELIVERY — every invited seat has an outcome, and no seat is silently
    // dropped. This is the report the runbook tells an operator to read.
    const byParty = new Map(
      body.invitations.map((entry) => [entry.partyId, entry])
    );
    expect(byParty.get(bo.ownerPartyId)?.state).toBe("queued");
    expect(byParty.get(cy.ownerPartyId)?.state).toBe("delivered");
    // The vault that disappeared is invited like anyone else — and, with no
    // link to the successor, ends as a carry-by-hand claim ticket.
    const orphan = byParty.get(steward.ownerPartyId);
    expect(orphan?.state).toBe("unreachable");
    expect(orphan?.claimToken).toBeTruthy();
    expect(byParty.size).toBe(3);

    // The co-hosted member really holds the invitation, with the successor's
    // id — not the dead grant's.
    const boInvites = listCommonsInvitations({
      seat: bo.vault.vault,
      memberVaultId: bo.vaultId,
    });
    const invite = boInvites.find((entry) => entry.grantId === body.grantId);
    expect(invite?.status).toBe("pending");
    expect(invite?.stewardVaultId).toBe(ana.vaultId);

    // 4. CONVERGE — Bo accepts, the successor steward admits the seat and
    // compiles: Bo now projects the successor grant, not the abandoned one.
    answerCommonsInvitation({
      seat: bo.vault,
      invitationId: invite!.invitationId,
      memberVaultId: bo.vaultId,
      answer: "accept",
      now: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    upsertCommonsMember({
      steward: ana.vault.vault,
      grantId: body.grantId,
      actorPartyId: ana.ownerPartyId,
      member: {
        partyId: bo.ownerPartyId,
        capability: "read+write",
        vaultId: bo.vaultId,
        vault: bo.vault,
      },
      now,
    });
    compileCommons({
      steward: ana.vault,
      stewardVaultId: ana.vaultId,
      grantId: body.grantId,
      seats: commonsSeats({
        steward: ana.vault.vault,
        grantId: body.grantId,
        stewardVaultId: ana.vaultId,
        vaultFor: (vaultId) =>
          vaultId === ana.vaultId
            ? ana.vault
            : vaultId === bo.vaultId
              ? bo.vault
              : undefined,
      }),
      now,
    });
    const boGrants = listCommonsGrants(bo.vault.vault);
    const successor = boGrants.find(
      (entry) => entry.grant.grantId === body.grantId
    );
    expect(successor).toBeDefined();
    expect(successor?.grant.stewardPartyId).toBe(ana.ownerPartyId);
    // The superseded grant is not deleted — it is stopped. Its history stays
    // exactly where it was on every seat that held it.
    expect(readCommonsGrant(ana.vault.vault, grantId).revokedAt).toBeTruthy();
    expect(boGrants.some((entry) => entry.grant.grantId === grantId)).toBe(
      true
    );
  });
});
