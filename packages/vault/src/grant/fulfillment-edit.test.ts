import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { nowIso, uuidv7 } from "../ids.js";
import { createCommonsGrant } from "../share/commons.js";
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
       (party_id, kind, display_name, sort_name, created_at, updated_at,
        ontology_version)
     VALUES (?, 'person', ?, ?, ?, ?, '1.4')`
  ).run(partyId, name, name, now, now);
  return partyId;
}

describe("grant/fulfillment-edit", () => {
  afterEach(closeOpenVaults);

  test("an edit on a shared tally group routes back to the commons rail", () => {
    const { origin, originBoot } = household();
    const now = nowIso();
    const ravi = addParty(origin.vault, "Ravi", now);
    const groupId = uuidv7();
    const commons = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "tally.group",
      containerId: groupId,
      members: [{ partyId: ravi, capability: "read+write" }],
      now,
    });
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
      commonsGrantId: commons.grantId,
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
    createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "tally.group",
      containerId: groupId,
      members: [
        { partyId: ravi, capability: "read+write" },
        { partyId: asha, capability: "read" },
      ],
      now,
    });
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
    createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "tally.group",
      containerId: groupId,
      members: [{ partyId: ravi, capability: "read" }],
      now,
    });
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

  test("a folder is shareable for view only, so every write into it refuses", () => {
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
    createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      containerType: "docs.folder",
      containerId: folderId,
      members: [{ partyId: ravi, capability: "read+write" }],
      now,
    });
    // `view`, because the registry offers a folder nothing else (#825, ruling
    // G-edit): albums and folders are view-capable and their edit strategy is
    // deferred, so an `edit` grant over one cannot be minted at all.
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
    // shared for view. The commons rail is live either way — it is the grant
    // that stops short, not the routing.
    expect(
      routeShareGrantEdit(origin.vault, {
        command: "core.add_document",
        commandInput: { folder_id: folderId },
      })?.refusal
    ).toBe(
      `core.add_document writes into docs.folder ${folderId}, which is shared for view only`
    );
    const documentId = uuidv7();
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
    ).toBe("co-contribution to docs.folder is not offered in v1");
  });

  test("an edit grant with no commons rail is refused, never applied privately", () => {
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
    expect(route?.commonsGrantId).toBeUndefined();
    expect(route?.refusal).toBe(
      `tally.group ${groupId} has no commons rail to route tally.add_expense to`
    );
  });
});
