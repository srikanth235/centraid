import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { nowIso, uuidv7 } from "../ids.js";
import { closeOpenVaults, household } from "../share/placement-fixture.js";
import {
  routeShareGrantEdit,
  shareGrantEditRefusal,
} from "./fulfillment-edit.js";
import { createShareGrant } from "./grant-store.js";
import type { ShareGrantCapability } from "./grant-store.js";

function addParty(db: DatabaseSync, name: string, now: string): string {
  const partyId = uuidv7();
  db.prepare(
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, created_at, updated_at)
     VALUES (?, 'person', ?, ?, ?, ?)`
  ).run(partyId, name, name, now, now);
  return partyId;
}

describe("grant/fulfillment-edit", () => {
  afterEach(closeOpenVaults);

  test("an edit on a shared tally group routes to its container", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const ravi = addParty(origin.vault, "Ravi", now);
    const groupId = uuidv7();
    createShareGrant(origin.vault, {
      audience: { kind: "party", id: ravi },
      subjectType: "tally.group",
      subjectId: groupId,
      capability: "edit",
      grantedAt: now,
      grantedBy: originBoot.ownerPartyId,
    });

    const route = routeShareGrantEdit(origin.vault, {
      command: "tally.add_expense",
      commandInput: { group_id: groupId },
    });
    expect(route).toMatchObject({
      containerType: "tally.group",
      containerId: groupId,
      actable: true,
    });
    expect(route?.refusal).toBeUndefined();
    expect(route?.grants).toHaveLength(1);
  });

  test("one audience's edit grant does not lend edit to another audience", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const ravi = addParty(origin.vault, "Ravi", now);
    const asha = addParty(origin.vault, "Asha", now);
    const groupId = uuidv7();
    for (const [party, capability] of [
      [ravi, "edit"],
      [asha, "view"],
    ] as const)
      createShareGrant(origin.vault, {
        audience: { kind: "party", id: party },
        subjectType: "tally.group",
        subjectId: groupId,
        capability,
        grantedAt: now,
        grantedBy: originBoot.ownerPartyId,
      });

    const route = routeShareGrantEdit(origin.vault, {
      command: "tally.add_expense",
      commandInput: { group_id: groupId },
    });
    if (!route) throw new Error("the shared group routed nowhere");
    // The CONTAINER question folds both grants together, so it refuses
    // nothing: something shared here does carry edit.
    expect(route.grants).toHaveLength(2);
    expect(route.refusal).toBeUndefined();

    const grantsFor = (partyId: string) =>
      route.grants.filter((grant) => grant.audience.id === partyId);
    // The ACTOR question is answered per audience: Asha holds view only, and
    // Ravi's edit grant next door does not lend her its capability.
    expect(shareGrantEditRefusal(route, grantsFor(asha))).toBe(
      `tally.add_expense writes into tally.group ${groupId}, which is shared for view only`
    );
    expect(shareGrantEditRefusal(route, grantsFor(ravi))).toBeUndefined();
  });

  test("a write that touches nothing shared is invisible to the grant plane", () => {
    const { origin } = household();
    expect(
      routeShareGrantEdit(origin.vault, {
        command: "tally.add_expense",
        commandInput: { group_id: uuidv7() },
      })
    ).toBeUndefined();
    expect(
      routeShareGrantEdit(origin.vault, {
        command: "home.update_item",
        commandInput: { item_id: uuidv7() },
      })
    ).toBeUndefined();
  });

  test("a view-only subject refuses the write instead of applying it", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const ravi = addParty(origin.vault, "Ravi", now);
    const groupId = uuidv7();
    createShareGrant(origin.vault, {
      audience: { kind: "party", id: ravi },
      subjectType: "tally.group",
      subjectId: groupId,
      capability: "view",
      grantedAt: now,
      grantedBy: originBoot.ownerPartyId,
    });

    expect(
      routeShareGrantEdit(origin.vault, {
        command: "tally.add_expense",
        commandInput: { group_id: groupId },
      })?.refusal
    ).toBe(
      `tally.add_expense writes into tally.group ${groupId}, which is shared for view only`
    );
  });

  test("a folder shared for view refuses every write into it", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const ravi = addParty(origin.vault, "Ravi", now);
    const schemeId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
         VALUES (?, 'https://centraid.dev/schemes/folders', 'Folders', NULL, '1')`
      )
      .run(schemeId);
    const folderId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO core_concept
           (concept_id, scheme_id, notation, pref_label, alt_labels_json,
            broader_concept_id, definition)
         VALUES (?, ?, 'trip', 'Trip', NULL, NULL, NULL)`
      )
      .run(folderId, schemeId);
    createShareGrant(origin.vault, {
      audience: { kind: "party", id: ravi },
      subjectType: "docs.folder",
      subjectId: folderId,
      capability: "view",
      grantedAt: now,
      grantedBy: originBoot.ownerPartyId,
    });

    // Adding a document to someone else's shared folder, and editing one
    // already inside it, refuse for the SAME reason in v1: the folder is
    // shared for view: it is the ANSWER that stops short, not the routing.
    expect(
      routeShareGrantEdit(origin.vault, {
        command: "core.add_document",
        commandInput: { folder_id: folderId },
      })?.refusal
    ).toBe(
      `core.add_document writes into docs.folder ${folderId}, which is shared for view only`
    );
    // A REAL document to file (#916): a tag's (target_type, target_id) is a
    // composite foreign key into the entity supertype.
    const documentId = uuidv7();
    const documentContentId = uuidv7();
    origin.vault
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES (?, 'text/plain', 'data:text/plain,x', ?, 1, ?)`
      )
      .run(documentContentId, `sha-${documentContentId}`.padEnd(64, "0"), now);
    origin.vault
      .prepare(
        `INSERT INTO core_document
           (document_id, title, current_content_id, created_at, updated_at)
         VALUES (?, 'Filed', ?, ?, ?)`
      )
      .run(documentId, documentContentId, now, now);
    origin.vault
      .prepare(
        `INSERT INTO core_tag
           (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
            confidence, tagged_at)
         VALUES (?, 'core.document', ?, ?, ?, 1.0, ?)`
      )
      .run(uuidv7(), documentId, folderId, originBoot.ownerPartyId, now);
    const edit = routeShareGrantEdit(origin.vault, {
      command: "core.edit_document",
      commandInput: { document_id: documentId },
    });
    expect(edit).toMatchObject({
      containerType: "docs.folder",
      containerId: folderId,
      actable: true,
    });
    expect(edit?.refusal).toBe(
      `core.edit_document writes into docs.folder ${folderId}, which is shared for view only`
    );

    // The co-contribution guard behind that refusal is still real: asked with
    // an edit-bearing audience, the folder still answers "not offered in v1".
    // Defence in depth for a grant row minted before the registry narrowed.
    expect(
      shareGrantEditRefusal(
        routeShareGrantEdit(origin.vault, {
          command: "core.add_document",
          commandInput: { folder_id: folderId },
        })!,
        (edit?.grants ?? []).map((grant) => ({
          ...grant,
          capability: "edit" as ShareGrantCapability,
        }))
      )
      // Folders are offered for edit since #929, so the co-contribution
      // refusal moved to the container that is still not: an album.
    ).toBeUndefined();
    expect(
      shareGrantEditRefusal(
        routeShareGrantEdit(origin.vault, {
          command: "core.add_document",
          commandInput: { folder_id: folderId },
        })!,
        (edit?.grants ?? []).map((grant) => ({
          ...grant,
          capability: "view" as ShareGrantCapability,
        }))
      )
    ).toBe(
      `core.add_document writes into docs.folder ${folderId}, which is shared for view only`
    );
  });

  /**
   * THE GRANT IS THE RAIL NOW (#929). A member's write is a signed replica
   * intent the ORIGIN executes, so a container needs no second grant row to be
   * writable: the `edit` answer in `share_authority` is the whole of the
   * authorization, and the refusal that used to name a missing commons rail
   * would refuse a write the origin can and should execute.
   */
  test("an edit grant needs no second rail row to be routable", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const ravi = addParty(origin.vault, "Ravi", now);
    const groupId = uuidv7();
    const capability: ShareGrantCapability = "edit";
    createShareGrant(origin.vault, {
      audience: { kind: "party", id: ravi },
      subjectType: "tally.group",
      subjectId: groupId,
      capability,
      grantedAt: now,
      grantedBy: originBoot.ownerPartyId,
    });

    const route = routeShareGrantEdit(origin.vault, {
      command: "tally.add_expense",
      commandInput: { group_id: groupId },
    });
    expect(route).toMatchObject({
      containerType: "tally.group",
      containerId: groupId,
      actable: true,
    });
    expect(route?.refusal).toBeUndefined();
  });
});
