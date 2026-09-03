import { afterEach, describe, expect, test } from "vitest";

import { nowIso } from "../ids.js";
import { exportCommonsSyncFrame } from "./commons-bootstrap.js";
import { readCommonsCursor } from "./commons-cursor.js";
import {
  folderCommons,
  MEMBER_VAULT,
  memberEmbeddings,
  memberOcrHits,
  seedMemberDerivedState,
  STEWARD_VAULT,
} from "./commons-replay.test-fixtures.js";
import { appendCommonsOperation, readCommonsGrant } from "./commons.js";
import type { CommonsMemberInput } from "./commons.js";
import { closeOpenVaults } from "./placement-fixture.js";

describe("Commons command-tail replay, local rail (issue #750 invariant 7)", () => {
  afterEach(closeOpenVaults);

  test("a laggard k operations behind catches up by replay and keeps its derived rows", () => {
    const fixture = folderCommons(6);
    const before = seedMemberDerivedState(fixture, "memberocrneedle");
    expect(memberOcrHits(fixture, "memberocrneedle")).toBe(1);
    const unchanged = fixture.documents.slice(1);

    const detached: CommonsMemberInput[] = [];
    fixture.write(
      "core.rename_document",
      { document_id: fixture.documents[0]!, title: "Renamed once" },
      { seats: detached }
    );
    fixture.write(
      "core.rename_document",
      { document_id: fixture.documents[0]!, title: "Renamed twice" },
      { seats: detached }
    );
    fixture.write(
      "core.create_folder",
      { name: "Receipts", parent_folder_id: fixture.folderId },
      { seats: detached }
    );
    expect(
      readCommonsCursor(
        fixture.home.audience.vault,
        fixture.grantId,
        MEMBER_VAULT
      )?.sequence
    ).toBe(0);

    const frame = exportCommonsSyncFrame({
      steward: fixture.home.origin.vault,
      identitySeed: fixture.home.origin.identitySeed,
      stewardVaultId: STEWARD_VAULT,
      grantId: fixture.grantId,
      memberVaultId: MEMBER_VAULT,
      afterSequence: 0,
    });
    if (frame.state !== "increment")
      throw new Error(`expected an increment frame, got ${frame.state}`);
    expect(frame.increment.ops).toHaveLength(3);
    const wire = JSON.stringify(frame.increment);
    for (const documentId of unchanged) expect(wire).not.toContain(documentId);

    fixture.compile();

    expect(fixture.documentTitle(fixture.documents[0]!)).toBe("Renamed twice");
    expect(
      fixture.home.audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM core_concept WHERE pref_label = 'Receipts'"
        )
        .get()
    ).toMatchObject({ n: 1 });
    expect(memberEmbeddings(fixture)).toBe(before.embeddings);
    expect(memberOcrHits(fixture, "memberocrneedle")).toBe(1);
    expect(
      fixture.home.audience.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM enrich_request WHERE drained_at IS NULL`
        )
        .get()
    ).toMatchObject({ n: 0 });
  });

  test("an operation this build cannot replay falls back to full projection and does not wedge the grant", () => {
    const fixture = folderCommons(3);
    const detached: CommonsMemberInput[] = [];
    fixture.write(
      "core.rename_document",
      { document_id: fixture.documents[0]!, title: "Before the skew" },
      { seats: detached }
    );
    appendCommonsOperation({
      steward: fixture.home.origin.vault,
      grantId: fixture.grantId,
      actorPartyId: fixture.home.originBoot.ownerPartyId,
      kind: "command",
      command: "future.reticulate_splines",
      input: { folder_id: fixture.folderId, splines: 3 },
      outcome: "executed",
      now: nowIso(),
    });

    fixture.compile();

    expect(fixture.documentTitle(fixture.documents[0]!)).toBe(
      "Before the skew"
    );
    expect(
      fixture.home.audience.vault
        .prepare("SELECT COUNT(*) AS n FROM core_document")
        .get()
    ).toMatchObject({ n: 3 });
    fixture.write("core.rename_document", {
      document_id: fixture.documents[1]!,
      title: "After the skew",
    });
    expect(fixture.documentTitle(fixture.documents[1]!)).toBe("After the skew");
    expect(
      readCommonsCursor(
        fixture.home.audience.vault,
        fixture.grantId,
        MEMBER_VAULT
      )?.sequence
    ).toBe(
      readCommonsGrant(fixture.home.origin.vault, fixture.grantId).lastSequence
    );
  });

  test("a replica whose projection the tail cannot resolve falls back to the full re-baseline", () => {
    const fixture = folderCommons(2);
    fixture.home.audience.vault
      .prepare("DELETE FROM core_document WHERE document_id = ?")
      .run(fixture.documents[0]!);
    fixture.write("core.rename_document", {
      document_id: fixture.documents[0]!,
      title: "Repaired",
    });
    expect(
      fixture.home.audience.vault
        .prepare("SELECT COUNT(*) AS n FROM core_document")
        .get()
    ).toMatchObject({ n: 2 });
    expect(fixture.documentTitle(fixture.documents[0]!)).toBe("Repaired");
  });

  test("re-compiling an already-replayed tail is a no-op", () => {
    const fixture = folderCommons(2);
    fixture.write("core.rename_document", {
      document_id: fixture.documents[0]!,
      title: "Once",
    });
    const snapshot = (): unknown =>
      fixture.home.audience.vault
        .prepare(
          `SELECT document_id, title, current_content_id FROM core_document
            ORDER BY document_id`
        )
        .all();
    const after = snapshot();
    fixture.compile();
    fixture.compile();
    expect(snapshot()).toStrictEqual(after);
    expect(
      fixture.home.audience.vault
        .prepare("SELECT COUNT(*) AS n FROM core_document")
        .get()
    ).toMatchObject({ n: 2 });
  });

  test("forceFullProjection bypasses replay and re-projects from the closure", () => {
    const fixture = folderCommons(2);
    fixture.write("core.rename_document", {
      document_id: fixture.documents[0]!,
      title: "Reconciled",
    });
    fixture.home.audience.vault
      .prepare(
        "UPDATE core_document SET title = 'drifted' WHERE document_id = ?"
      )
      .run(fixture.documents[1]!);
    fixture.compile({ forceFullProjection: true });
    expect(fixture.documentTitle(fixture.documents[1]!)).toBe("Booking 1");
    expect(fixture.documentTitle(fixture.documents[0]!)).toBe("Reconciled");
  });
});
