// IDENTITY SCENARIOS — a revision is an occurrence, not a content id
// (#996 wave 0b, ruling R20(a) / [#916]'s ONT-revisions; drift row ONT-22).
//
// Version lineage was a `revises` `core.link` between content items, so the
// CONTENT id was the version id. Three things followed, and each is a scenario
// here, driven through the real commands and read back through the real
// history the app queries walk:
//
//   1. Two documents with identical bytes shared ONE history — content is
//      hash-deduped, so both wrappers pointed into the same chain.
//   2. A→B→A→B could not be expressed: the second A→B edge already existed and
//      `core_link_live_edge_idx` refused it, so a document that returned to a
//      body it had held collapsed two versions into one node.
//   3. A revision of one object could be restored into another, because "is
//      this content in the chain" was a question about a shared graph.

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../gateway/types.js";
import { registerDocumentCommands } from "./documents.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

const body = (text: string): string =>
  `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;

describe("core.document — the revision occurrence", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerDocumentCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  afterEach(() => {
    db.close();
  });

  function invoke(
    command: string,
    input: Record<string, unknown>
  ): InvokeOutcome {
    return gw.invoke(owner, { command, input });
  }

  function addDocument(title: string, text: string) {
    const outcome = invoke("core.add_document", {
      title,
      data_uri: body(text),
    });
    expect(outcome.status).toBe("executed");
    return (outcome as { output: { document_id: string; content_id: string } })
      .output;
  }

  function edit(documentId: string, text: string): string {
    const outcome = invoke("core.edit_document", {
      document_id: documentId,
      body_text: text,
    });
    expect(outcome.status).toBe("executed");
    return (outcome as { output: { content_id: string } }).output.content_id;
  }

  /** The document's own history, oldest first — the walk every reader does. */
  function history(documentId: string): string[] {
    return (
      db.vault
        .prepare(
          `WITH RECURSIVE chain(revision_id, content_id, parent_revision_id, depth) AS (
             SELECT r.revision_id, r.content_id, r.parent_revision_id, 0
               FROM core_entity_revision r
               JOIN core_document d ON d.current_revision_id = r.revision_id
              WHERE d.document_id = ?
             UNION
             SELECT r.revision_id, r.content_id, r.parent_revision_id, chain.depth + 1
               FROM core_entity_revision r
               JOIN chain ON chain.parent_revision_id = r.revision_id
           )
           SELECT content_id FROM chain ORDER BY depth DESC`
        )
        .all(documentId) as { content_id: string }[]
    ).map((row) => row.content_id);
  }

  test("two documents with identical bytes keep separate histories", () => {
    const first = addDocument("Template A.txt", "the same words");
    const second = addDocument("Template B.txt", "the same words");
    // The BYTES are deduped — that is the point of a content-addressed store,
    // and it is exactly why content could not be the version id.
    expect(second.content_id).toBe(first.content_id);
    expect(second.document_id).not.toBe(first.document_id);

    const firstV2 = edit(first.document_id, "A goes its own way");
    expect(history(first.document_id)).toStrictEqual([
      first.content_id,
      firstV2,
    ]);
    // B is untouched by A's edit. Before the occurrence, the `revises` edge out
    // of the shared content id was in B's chain too.
    expect(history(second.document_id)).toStrictEqual([second.content_id]);
  });

  test("A→B→A→B is four occurrences, in order", () => {
    const { document_id: documentId, content_id: a } = addDocument(
      "Doc.txt",
      "A"
    );
    const b = edit(documentId, "B");
    const backToA = edit(documentId, "A");
    const backToB = edit(documentId, "B");
    // The bytes dedupe, so this is two content ids and four versions — which
    // is the whole distinction the occurrence makes.
    expect(backToA).toBe(a);
    expect(backToB).toBe(b);
    expect(history(documentId)).toStrictEqual([a, b, a, b]);
    expect(
      db.vault
        .prepare(
          `SELECT count(*) AS n FROM core_entity_revision
            WHERE entity_type = 'core.document' AND entity_id = ?
              AND content_id IS NOT NULL`
        )
        .get(documentId) as { n: number }
    ).toMatchObject({ n: 4 });
  });

  test("restoring another document's revision is refused", () => {
    const mine = addDocument("Mine.txt", "mine v1");
    const mineV2 = edit(mine.document_id, "mine v2");
    const theirs = addDocument("Theirs.txt", "theirs v1");
    const theirsV2 = edit(theirs.document_id, "theirs v2");
    expect(theirsV2).not.toBe(mineV2);

    // A content item that exists, is live, and is a genuine version — of
    // something else. The old chain question was asked of a shared graph and
    // could not tell the difference.
    const outcome = invoke("core.restore_document_version", {
      document_id: mine.document_id,
      content_id: theirs.content_id,
    });
    expect(outcome.status).toBe("failed");
    expect(history(mine.document_id)).toStrictEqual([mine.content_id, mineV2]);

    // And the document's own earlier version still restores.
    expect(
      invoke("core.restore_document_version", {
        document_id: mine.document_id,
        content_id: mine.content_id,
      }).status
    ).toBe("executed");
    expect(history(mine.document_id)).toStrictEqual([
      mine.content_id,
      mineV2,
      mine.content_id,
    ]);
  });

  test("no `revises` link is written by any body edit", () => {
    const { document_id: documentId } = addDocument("Doc.txt", "v1");
    edit(documentId, "v2");
    edit(documentId, "v3");
    expect(
      db.vault
        .prepare(
          `SELECT count(*) AS n FROM core_link l
             JOIN core_concept c ON c.concept_id = l.relation_concept_id
            WHERE c.notation = 'revises'`
        )
        .get() as { n: number }
    ).toMatchObject({ n: 0 });
    // The concept itself is not seeded any more: dormant DDL is a finding
    // (#916, ONT-06), and nothing writes the edge it named.
    expect(
      db.vault
        .prepare(
          "SELECT count(*) AS n FROM core_concept WHERE notation = 'revises'"
        )
        .get() as { n: number }
    ).toMatchObject({ n: 0 });
  });
});
