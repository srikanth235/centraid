/*
 * TWO VAULTS ON ONE GATEWAY (#1014, S2; ruling R-1014-10).
 *
 * A local pair is linked with `remoteVaultId: null` and no route: there is
 * nothing to dial. What this holds is that the two halves the AUDIENCE drives
 * work anyway — it can pull its own catch-up, and an `edit` grant is an edit
 * that lands in the origin — and that the grant is still what authorizes:
 * a vault the grant does not reach is refused on the local path exactly as it
 * is on the peer one.
 */

import { describe, expect, test, vi } from "vitest";

import { shareShapeId } from "@centraid/core/protocol";
import {
  createShareGrant,
  forwardProjectedEdit,
  nowIso,
  readSubscription,
  registerTallyCommands,
  revokeShareGrant,
  uuidv7,
} from "@centraid/vault";

import {
  forwardProjectedEditLocally,
  pullShareTailLocally,
} from "./local-share-path.js";
import { makeCoHostedSides } from "./peer-give.test-fixtures.js";
import type { Side } from "./peer-give.test-fixtures.js";
import {
  addLocalParty,
  bindPartyToVault,
  seedEverySubject,
} from "./share-subscription-peer.test-fixtures.js";

vi.setConfig({ testTimeout: 60_000 });

function hostOf(
  origin: Side,
  audience: Side
): {
  vaultFor: (vaultId: string) => Side["vault"] | undefined;
  gatewayFor: (vaultId: string) => Side["gateway"] | undefined;
  credentialFor: (vaultId: string) => Side["ownerCredential"] | undefined;
  labelFor: (vaultId: string) => string | undefined;
  now: () => string;
} {
  const sides = new Map([
    [origin.vaultId, origin],
    [audience.vaultId, audience],
  ]);
  return {
    vaultFor: (vaultId) => sides.get(vaultId)?.vault,
    gatewayFor: (vaultId) => sides.get(vaultId)?.gateway,
    credentialFor: (vaultId) => sides.get(vaultId)?.ownerCredential,
    labelFor: (vaultId) => sides.get(vaultId)?.label,
    now: nowIso,
  };
}

describe("the same-gateway share path", () => {
  test("the audience pulls its own catch-up with nothing to dial", () => {
    const [origin, audience] = makeCoHostedSides(
      "lsp-host",
      "lsp-origin",
      "lsp-audience"
    );
    const audienceParty = addLocalParty(origin, "Co-hosted");
    bindPartyToVault(origin, audienceParty, audience.vaultId);
    const photo = seedEverySubject(
      origin,
      addLocalParty(origin, "Ledger member")
    ).find((subject) => subject.subjectType === "media.asset")!;
    const grant = createShareGrant(origin.vault.vault, {
      audience: { kind: "party", id: audienceParty },
      subjectType: "media.asset",
      subjectId: photo.subjectId,
      capability: "view",
      grantedAt: nowIso(),
      grantedBy: origin.ownerPartyId,
    });
    const host = hostOf(origin, audience);
    const pull = (): ReturnType<typeof pullShareTailLocally> =>
      pullShareTailLocally(host, {
        originVaultId: origin.vaultId,
        audienceVaultId: audience.vaultId,
        shapeId: shareShapeId(grant.grantId),
        seat: audience.vault,
      });

    const first = pull();
    expect(first?.state, JSON.stringify(first)).toBe("applied");
    expect(
      audience.vault.vault
        .prepare("SELECT count(*) AS n FROM media_asset")
        .get()
    ).toMatchObject({ n: 1 });
    // The bytes crossed too: one host, one filesystem, so they are placed.
    expect(audience.vault.blobs.local.listSync().length).toBeGreaterThan(0);
    const cursorAfterFirst = readSubscription(
      audience.vault.vault,
      grant.grantId,
      audience.vaultId
    )?.cursor.seq;
    expect(cursorAfterFirst).toBeGreaterThan(0);

    // A vault the grant does not reach gets nothing, on the local path too.
    expect(
      pullShareTailLocally(host, {
        originVaultId: origin.vaultId,
        audienceVaultId: `vlt_${uuidv7()}`,
        shapeId: shareShapeId(grant.grantId),
        seat: audience.vault,
      })
    ).toBeUndefined();

    // A revoked grant is not a shape any more.
    revokeShareGrant(origin.vault.vault, {
      grantId: grant.grantId,
      revokedAt: nowIso(),
    });
    expect(pull()).toBeUndefined();

    origin.vault.close();
    audience.vault.close();
  });

  test("an edit made in the audience lands in the origin", () => {
    const [origin, audience] = makeCoHostedSides(
      "lsp-edit-host",
      "lsp-edit-origin",
      "lsp-edit-audience"
    );
    registerTallyCommands(origin.gateway);
    const memberParty = addLocalParty(origin, "Co-hosted member");
    bindPartyToVault(origin, memberParty, audience.vaultId);
    const group = seedEverySubject(origin, memberParty).find(
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
    const host = hostOf(origin, audience);
    const applied = pullShareTailLocally(host, {
      originVaultId: origin.vaultId,
      audienceVaultId: audience.vaultId,
      shapeId: shareShapeId(grant.grantId),
      seat: audience.vault,
    });
    expect(applied?.state, JSON.stringify(applied)).toBe("applied");

    // The audience holds a PROJECTED group, and asking where its edit belongs
    // answers with the origin — the route the forwarder is handed.
    const localGroupId = (
      audience.vault.vault
        .prepare("SELECT group_id FROM tally_group")
        .get() as { group_id: string }
    ).group_id;
    const route = forwardProjectedEdit(audience.vault.vault, {
      entity: "tally.group",
      rowId: localGroupId,
    })!;
    expect(route.originVaultId).toBe(origin.vaultId);

    const before = (
      origin.vault.vault
        .prepare("SELECT count(*) AS n FROM tally_expense WHERE group_id = ?")
        .get(group.subjectId) as { n: number }
    ).n;
    const answer = forwardProjectedEditLocally(host, {
      route,
      audienceVaultId: audience.vaultId,
      intentId: uuidv7(),
      appId: "tally",
      action: "tally.add_expense",
      input: {
        group_id: group.subjectId,
        description: "Taxi",
        amount_minor: 1200,
        category: "transport",
        paid_by: origin.ownerPartyId,
        splits: [
          { party_id: origin.ownerPartyId, share_minor: 600 },
          { party_id: memberParty, share_minor: 600 },
        ],
      },
      baseVersions: [],
    });
    expect(answer?.status, JSON.stringify(answer)).toBe("executed");
    // ONE WRITER: the row is in the ORIGIN's vault, not the member's.
    expect(
      (
        origin.vault.vault
          .prepare("SELECT count(*) AS n FROM tally_expense WHERE group_id = ?")
          .get(group.subjectId) as { n: number }
      ).n
    ).toBe(before + 1);
    expect(
      (
        audience.vault.vault
          .prepare("SELECT count(*) AS n FROM tally_expense")
          .get() as { n: number }
      ).n
    ).toBe(before);

    // And it relays back: the next pull carries the origin's new row.
    const relay = pullShareTailLocally(host, {
      originVaultId: origin.vaultId,
      audienceVaultId: audience.vaultId,
      shapeId: shareShapeId(grant.grantId),
      seat: audience.vault,
    });
    expect(relay?.state).toBe("applied");
    expect(
      (
        audience.vault.vault
          .prepare("SELECT count(*) AS n FROM tally_expense")
          .get() as { n: number }
      ).n
    ).toBe(before + 1);

    origin.vault.close();
    audience.vault.close();
  });
});
