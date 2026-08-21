/** The two member-facing Commons cards (issue #750): steward absence and a
 *  commons that outgrew the size its member consented to. */

import { describe, expect, test } from "vitest";

import {
  answerCommonsInvitation,
  commonsCurrentSize,
  commonsSeats,
  compileCommons,
  createCommonsGrant,
  queueCommonsInvitation,
} from "@centraid/vault";

import {
  COMMONS_GROWTH_NOTICE_KIND,
  commonsAbsenceNotice,
  raiseCommonsNotices,
  shouldWriteCommonsAbsenceNotice,
} from "./commons-notices.js";
import { NoticeStore } from "./notices.js";
import { makeSide, seedPhoto } from "./peer-give.test-fixtures.js";

describe("commons notices", () => {
  test("a commons that outgrew the accepted size raises one card on the member seat", () => {
    const steward = makeSide("growth-steward");
    const member = makeSide("growth-member");
    const now = new Date().toISOString();
    const photo = seedPhoto(steward, "growth");
    const grant = createCommonsGrant({
      origin: steward.vault.vault,
      ownerPartyId: steward.ownerPartyId,
      ownerVaultId: steward.vaultId,
      ownerVault: steward.vault,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [
        {
          partyId: member.ownerPartyId,
          capability: "read+write",
          vaultId: member.vaultId,
          vault: member.vault,
          vaultPublicKey: member.publicKey,
        },
      ],
      now,
    });
    compileCommons({
      steward: steward.vault,
      stewardVaultId: steward.vaultId,
      grantId: grant.grantId,
      seats: commonsSeats({
        steward: steward.vault.vault,
        grantId: grant.grantId,
        stewardVaultId: steward.vaultId,
        vaultFor: (vaultId) =>
          vaultId === steward.vaultId
            ? steward.vault
            : vaultId === member.vaultId
              ? member.vault
              : undefined,
      }),
      now,
    });
    const current = commonsCurrentSize(
      member.vault.vault,
      member.vaultId,
      grant.grantId
    );
    expect(current).toBeGreaterThan(0);
    // The member accepted a MUCH smaller space than the one they now hold.
    const invitation = queueCommonsInvitation({
      seat: member.vault.vault,
      invitation: {
        grantId: grant.grantId,
        stewardVaultId: steward.vaultId,
        memberVaultId: member.vaultId,
        memberPartyId: member.ownerPartyId,
        capability: "read+write",
        containerType: "media.asset",
        containerId: photo.assetId,
        containerLabel: "Trip photos",
        currentSizeBytes: 1,
      },
      now,
    });
    answerCommonsInvitation({
      seat: member.vault,
      invitationId: invitation.invitationId,
      memberVaultId: member.vaultId,
      answer: "accept",
      now,
    });

    const raised = raiseCommonsNotices({
      db: member.vault,
      vaultId: member.vaultId,
    });
    expect(raised.map((notice) => notice.kind)).toContain(
      COMMONS_GROWTH_NOTICE_KIND
    );
    const card = new NoticeStore(member.vault.vault).getBySource(
      COMMONS_GROWTH_NOTICE_KIND,
      grant.grantId
    );
    expect(card?.headline).toContain("Trip photos");
    expect(card?.detail["acceptedSizeBytes"]).toBe(1);
    expect(card?.detail["currentSizeBytes"]).toBe(current);
    // ONE card: the consent that was given never changes, so the growth is
    // stated once instead of on every byte added afterward.
    expect(
      raiseCommonsNotices({ db: member.vault, vaultId: member.vaultId })
    ).toStrictEqual([]);
    expect(
      new NoticeStore(member.vault.vault).getBySource(
        COMMONS_GROWTH_NOTICE_KIND,
        grant.grantId
      )?.count
    ).toBe(1);
  });

  test("an absence card names the recovery step only when recovery is honest", () => {
    const absent = commonsAbsenceNotice({
      grantId: "g1",
      containerType: "media.asset",
      presence: "absent",
      silentForMs: 9 * 24 * 60 * 60 * 1000,
    });
    expect(absent.headline).toContain("9 days");
    expect(absent.detail?.["recoverable"]).toBe(true);
    // The card has to name a place a client can actually go: Household, whose
    // People & circles panel offers the ceremony (issue #750).
    expect(absent.detail?.["deepLink"]).toBe("/household");
    // A seat parked on a divergence fault must never be re-founded from state
    // it could not verify, so its card does not offer the ceremony.
    const parked = commonsAbsenceNotice({
      grantId: "g1",
      containerType: "media.asset",
      presence: "parked",
      fault: "history-diverged",
    });
    expect(parked.detail?.["recoverable"]).toBe(false);
    expect(shouldWriteCommonsAbsenceNotice(undefined, "absent")).toBe(true);
  });
});
