import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import {
  fulfillShareGrant,
  propagateShareGrantRevocation,
} from "../grant/fulfillment.js";
import {
  createShareGrant,
  readFulfillment,
  revokeShareGrant,
} from "../grant/grant-store.js";
import { nowIso, uuidv7 } from "../ids.js";
import type { Household } from "./placement-fixture.js";
import {
  closeOpenVaults,
  household,
  seedPhoto,
} from "./placement-fixture.js";

const AUDIENCE_VAULT = "vault-family";
const ORIGIN_VAULT = "vault-priya";

function addParty(db: DatabaseSync, name: string, now: string): string {
  const partyId = uuidv7();
  db.prepare(
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, created_at, updated_at,
        ontology_version)
     VALUES (?, 'person', ?, ?, ?, ?, '1.4')`
  ).run(partyId, name, name, now, now);
  return partyId;
}

function linkVault(
  db: DatabaseSync,
  partyId: string,
  vaultId: string,
  now: string
): void {
  db.prepare(
    `INSERT INTO share_party_vault_binding
       (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
     VALUES (?, ?, ?, NULL, ?, NULL)`
  ).run(uuidv7(), partyId, vaultId, now);
}

function seedAlbum(home: Household, now: string): string {
  const first = seedPhoto(home.origin, home.originBoot, "a");
  const albumId = uuidv7();
  home.origin.vault
    .prepare(
      `INSERT INTO core_collection
         (collection_id, owner_party_id, name, cover_content_id,
          parent_collection_id, sort_order, created_at)
       VALUES (?, ?, 'Trip', ?, NULL, 0, ?)`
    )
    .run(albumId, home.originBoot.ownerPartyId, first.contentId, now);
  home.origin.vault
    .prepare(
      `INSERT INTO core_collection_entry
         (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, 'media.asset', ?, 0, ?)`
    )
    .run(uuidv7(), albumId, first.assetId, now);
  return albumId;
}

describe("probe", () => {
  afterEach(closeOpenVaults);

  test("delivered -> unreachable pass -> revoke -> reachable propagate", () => {
    const home = household();
    const now = nowIso();
    const ravi = addParty(home.origin.vault, "Ravi", now);
    linkVault(home.origin.vault, ravi, AUDIENCE_VAULT, now);
    const albumId = seedAlbum(home, now);
    const reach = (vaultId: string) =>
      vaultId === AUDIENCE_VAULT ? home.audience : undefined;
    const grant = createShareGrant(home.origin.vault, {
      audience: { kind: "party", id: ravi },
      subjectType: "core.collection",
      subjectId: albumId,
      capability: "view",
      grantedAt: now,
      grantedBy: home.originBoot.ownerPartyId,
    });
    fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: reach,
      now,
    });
    expect(
      readFulfillment(home.origin.vault, grant.grantId, AUDIENCE_VAULT)
    ).toMatchObject({ state: "delivered" });

    // The host loses reach for one pass. The row falls back to `syncing`.
    fulfillShareGrant({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: () => undefined,
      now,
    });
    expect(
      readFulfillment(home.origin.vault, grant.grantId, AUDIENCE_VAULT)
    ).toMatchObject({ state: "syncing" });

    revokeShareGrant(home.origin.vault, { grantId: grant.grantId, revokedAt: now });
    const removal = propagateShareGrantRevocation({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      seatFor: reach,
      now,
    });
    const held = home.audience.vault
      .prepare("SELECT COUNT(*) AS n FROM core_share_origin")
      .get();
    const titles = home.audience.vault
      .prepare("SELECT title FROM core_content_item")
      .all();
    expect({
      steps: removal.steps,
      held,
      titles,
      state: readFulfillment(
        home.origin.vault,
        grant.grantId,
        AUDIENCE_VAULT
      ),
    }).toStrictEqual("SHOW ME");
  });
});
