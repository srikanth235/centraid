/*
 * A CROSS-HOST DELIVERY THAT NEVER LANDS GETS A SURFACE (#1014, T15).
 *
 * `syncing` was the one indefinite silent non-delivery state in the share
 * plane: the row parks, the sweep keeps ringing an audience that never
 * answers, and the owner reads their share as sent. What this holds is that
 * the silence is BOUNDED by a named constant and no more — nothing is
 * cancelled, the card is raised once per (grant, peer), and it goes when the
 * audience finally answers.
 */

import { describe, expect, test } from "vitest";

import { createShareGrant, nowIso, setFulfillmentState } from "@centraid/vault";

import {
  closeOpenVaults,
  sharedWorld,
} from "./grant-fulfillment.test-fixtures.js";
import { NoticeStore } from "./notices.js";
import {
  clearShareSyncingNotice,
  raiseShareSyncingNotice,
  SHARE_SYNCING_NOTICE_AFTER_MS,
  SHARE_SYNCING_NOTICE_KIND,
} from "./share-notices.js";

const PEER = "vlt_far_away";

function laterBy(from: string, ms: number): string {
  return new Date(Date.parse(from) + ms).toISOString();
}

describe("a share that the audience never confirms", () => {
  test("is silent for exactly the named window, then named to the owner", () => {
    const world = sharedWorld();
    // A grant to a peer this host cannot reach: the pass leaves the row
    // `syncing` and the sweep drains it only when the audience answers.
    const grant = createShareGrant(world.priya.vault.vault, {
      audience: { kind: "party", id: world.raviParty },
      subjectType: "core.document",
      subjectId: world.documentId,
      capability: "view",
      grantedAt: world.now,
      grantedBy: world.priya.boot.ownerPartyId,
    });
    setFulfillmentState(world.priya.vault.vault, {
      grantId: grant.grantId,
      peerVaultId: PEER,
      state: "syncing",
      updatedAt: world.now,
    });
    const notices = new NoticeStore(world.priya.vault.vault);
    const card = (): ReturnType<NoticeStore["getBySource"]> =>
      notices.getBySource(
        SHARE_SYNCING_NOTICE_KIND,
        `${grant.grantId}:${PEER}`
      );
    const raise = (now: string): unknown =>
      raiseShareSyncingNotice({
        origin: world.priya.vault,
        grantId: grant.grantId,
        peerVaultId: PEER,
        peerLabel: "Ravi",
        detail: "the audience did not acknowledge the shape",
        now,
      });

    // Inside the window the plane's own retries own it: no card.
    raise(laterBy(world.now, SHARE_SYNCING_NOTICE_AFTER_MS - 1000));
    expect(card()).toBeUndefined();

    raise(laterBy(world.now, SHARE_SYNCING_NOTICE_AFTER_MS + 1000));
    const raised = card();
    expect(raised).toMatchObject({
      headline: "Ravi has not confirmed the share you sent",
      severity: "warning",
      count: 1,
    });

    // Once per (grant, peer): a sweep that runs every few seconds must not
    // resurface a card the owner has read.
    notices.markRead(raised!.noticeId);
    raise(laterBy(world.now, SHARE_SYNCING_NOTICE_AFTER_MS + 60_000));
    expect(card()?.readAt).toBeTypeOf("string");

    // And it goes when the audience finally answers.
    clearShareSyncingNotice({
      origin: world.priya.vault,
      grantId: grant.grantId,
      peerVaultId: PEER,
      now: laterBy(world.now, SHARE_SYNCING_NOTICE_AFTER_MS + 120_000),
    });
    expect(card()?.archivedAt).toBeTypeOf("string");
    // Archived is off the owner's list, which is what "cleared" means here.
    expect(
      notices.list().some((notice) => notice.kind === SHARE_SYNCING_NOTICE_KIND)
    ).toBe(false);
    closeOpenVaults();
  });

  test("says nothing about a grant this peer has already been delivered", () => {
    const world = sharedWorld();
    const grant = createShareGrant(world.priya.vault.vault, {
      audience: { kind: "party", id: world.raviParty },
      subjectType: "core.document",
      subjectId: world.documentId,
      capability: "view",
      grantedAt: world.now,
      grantedBy: world.priya.boot.ownerPartyId,
    });
    setFulfillmentState(world.priya.vault.vault, {
      grantId: grant.grantId,
      peerVaultId: PEER,
      state: "delivered",
      updatedAt: world.now,
    });
    setFulfillmentState(world.priya.vault.vault, {
      grantId: grant.grantId,
      peerVaultId: PEER,
      state: "syncing",
      updatedAt: world.now,
    });
    // A stalled FOLLOW-UP to an audience that has answered before is not
    // silence — the card is about a share that never arrived at all.
    raiseShareSyncingNotice({
      origin: world.priya.vault,
      grantId: grant.grantId,
      peerVaultId: PEER,
      now: laterBy(world.now, SHARE_SYNCING_NOTICE_AFTER_MS * 10),
    });
    expect(
      new NoticeStore(world.priya.vault.vault).getBySource(
        SHARE_SYNCING_NOTICE_KIND,
        `${grant.grantId}:${PEER}`
      )
    ).toBeUndefined();
    closeOpenVaults();
  });

  test("a vault with no such fulfillment row is not a stalled delivery", () => {
    const world = sharedWorld();
    expect(
      raiseShareSyncingNotice({
        origin: world.priya.vault,
        grantId: "no-such-grant",
        peerVaultId: PEER,
        now: nowIso(),
      })
    ).toBeUndefined();
    closeOpenVaults();
  });
});
