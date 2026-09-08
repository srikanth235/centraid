// IDENTITY — the scenarios wave 0b landed (#996).
//
// Five findings of one shape: something that is not an identity was being used
// as one — a preference index that spanned history, a short handle with no
// namespace, a provider's own reference with no source, a content hash as a
// document's identity, and a Latin-alphabet slug as a concept's. Each runs the
// real command or the real import path and reads back through the resolver a
// surface reads through.

import { partyForReach } from "../../../src/commands/contact-reach.js";
import { ENRICH_PUBLISHERS } from "../../../src/ingest/enrich-publishers.js";
import { mediaTypeOfOwner } from "../../../src/schema/representation.js";
import type { ScenarioCheck, ScenarioDefinition } from "./types.js";

/** One statement line, referenced `ref-1` by whichever bank produced it. */
const STATEMENT = [
  "Date,Description,Amount,Reference",
  "2026-07-01,Grocers,-1842.50,ref-1",
].join("\n");

/** The SAME bytes, offered twice under two different declared types. */
const SHARED_BODY = "<p>Ship it.</p>";
const AS_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(SHARED_BODY)}`;
const AS_TEXT = `data:text/plain;charset=utf-8,${encodeURIComponent(SHARED_BODY)}`;

const bodyUri = (text: string): string =>
  `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;

export const IDENTITY_SCENARIOS: readonly ScenarioDefinition[] = [
  {
    id: "ONT-30/primary-preference-is-not-history",
    drift: "ONT-30",
    title: "an end-dated primary does not block its replacement",
    surfaces: ["Contacts — the person's identifiers", "Atlas — the row editor"],
    run(ctx): ScenarioCheck[] {
      const partyId = ctx.execute<{ party_id: string }>("core.add_party", {
        display_name: "Alice",
        identifiers: [{ scheme: "handle", value: "@alice-old" }],
      }).party_id;
      const retired = ctx.row<{ identifier_id: string }>(
        `SELECT identifier_id FROM core_party_identifier
          WHERE party_id = ? AND value = '@alice-old'`,
        partyId
      )!.identifier_id;
      // Later than the instant the register minted: an interval runs forward,
      // and the fixture's clock is the vault's clock (R20(e)).
      ctx.clock.advance(60_000);
      const retiredAt = ctx.clock.nowIso();
      ctx.execute("atlas.update_row", {
        table: "core.party_identifier",
        id: retired,
        set: { valid_to: retiredAt },
      });
      const replacement = ctx.invoke("atlas.insert_row", {
        table: "core.party_identifier",
        values: {
          party_id: partyId,
          scheme: "handle",
          value: "@alice-new",
          is_primary: 1,
          valid_from: retiredAt,
        },
      });
      const inverted = ctx.invoke("atlas.insert_row", {
        table: "core.party_identifier",
        values: {
          party_id: partyId,
          scheme: "handle",
          value: "@alice-inverted",
          is_primary: 0,
          valid_from: retiredAt,
          valid_to: "2020-01-01T00:00:00.000Z",
        },
      });
      const now = ctx.clock.nowIso();
      return [
        {
          claim: "the replacement primary is accepted",
          actual: replacement.status,
          expected: "executed",
        },
        {
          claim: "an interval that runs backwards is refused",
          actual: inverted.status,
          expected: "failed",
        },
        {
          claim: "the resolver reads the live handle",
          actual: partyForReach(ctx.db.vault, "handle", "@alice-new", now),
          expected: partyId,
        },
        {
          claim: "the retired handle resolves to nobody",
          actual: partyForReach(ctx.db.vault, "handle", "@alice-old", now),
          expected: null,
        },
      ];
    },
  },
  {
    id: "ONT-30/a-handle-is-not-globally-unique",
    drift: "ONT-30",
    title: "the same short handle in two issuers is two identities",
    surfaces: [
      "Contacts — the person's identifiers",
      "Social — identity resolution",
    ],
    run(ctx): ScenarioCheck[] {
      const mine = ctx.execute<{ party_id: string }>("core.add_party", {
        display_name: "Dara",
        identifiers: [{ scheme: "handle", value: "@alice" }],
      }).party_id;
      const other = ctx.execute<{ party_id: string }>("core.add_party", {
        display_name: "Eve",
      }).party_id;
      const elsewhere = ctx.invoke("atlas.insert_row", {
        table: "core.party_identifier",
        values: {
          party_id: other,
          scheme: "handle",
          value: "@alice",
          issuer: "example.social",
          is_primary: 1,
          valid_from: ctx.clock.nowIso(),
        },
      });
      // The fork the index still refuses: same scheme, same value, same
      // (absent) namespace — that IS one identity claimed twice.
      const fork = ctx.invoke("atlas.insert_row", {
        table: "core.party_identifier",
        values: {
          party_id: other,
          scheme: "handle",
          value: "@alice",
          is_primary: 0,
          valid_from: ctx.clock.nowIso(),
        },
      });
      return [
        {
          claim: "`@alice` on another service is another person",
          actual: elsewhere.status,
          expected: "executed",
        },
        {
          claim: "`@alice` in the same namespace is still one person",
          actual: fork.status,
          expected: "failed",
        },
        {
          claim: "the unqualified handle still resolves to its owner",
          actual: partyForReach(
            ctx.db.vault,
            "handle",
            "@alice",
            ctx.clock.nowIso()
          ),
          expected: mine,
        },
      ];
    },
  },
  {
    id: "ONT-29/a-label-is-not-a-concept",
    drift: "ONT-29",
    title: "猫, 犬, कुत्ता and बिल्ली are four concepts",
    surfaces: ["Photos — the tag row", "Search — tag filters"],
    run(ctx): ScenarioCheck[] {
      const publisher = ENRICH_PUBLISHERS.find(
        (candidate) => candidate.entityType === "core.tag"
      )!;
      const labels = ["猫", "犬", "कुत्ता", "बिल्ली"];
      const conceptIds = labels.map((label, index) => {
        const created = publisher.create(
          ctx.db.vault,
          ctx.boot.ownerPartyId,
          {
            target_type: "core.party",
            target_id: ctx.boot.ownerPartyId,
            label,
            confidence: 0.5 + index / 100,
          },
          ctx.clock.nowIso()
        );
        return ctx.row<{ concept_id: string }>(
          "SELECT concept_id FROM core_tag WHERE tag_id = ?",
          created.entityId
        )!.concept_id;
      });
      const preferred = ctx
        .rows<{ pref_label: string }>(
          `SELECT pref_label FROM core_concept
            WHERE concept_id IN (${conceptIds.map(() => "?").join(", ")})`,
          ...conceptIds
        )
        .map((concept) => concept.pref_label)
        .toSorted();
      return [
        {
          claim: "four labels select four concepts",
          actual: new Set(conceptIds).size,
          expected: 4,
        },
        {
          claim: "each concept keeps the label it was made from",
          actual: preferred,
          expected: labels.toSorted(),
        },
      ];
    },
  },
  {
    id: "ONT-24/a-provider-id-is-scoped-to-its-source",
    drift: "ONT-24",
    title: "Bank A and Bank B may both import `ref-1`",
    surfaces: ["Tally — the ledger", "Finance — the import review"],
    run(ctx): ScenarioCheck[] {
      const importStatement = (filename: string, accountName: string) => {
        const staged = ctx.gateway.stageImportFile(ctx.owner, {
          filename,
          data: STATEMENT,
          accountName,
          currency: "INR",
        });
        return {
          staged: staged.staged,
          published: ctx.gateway.publishImport(ctx.owner, staged.batchId),
        };
      };
      const first = importStatement("bank-a-june.csv", "Bank A Savings");
      const second = importStatement("bank-b-june.csv", "Bank B Current");
      // The same source again: dedupe is the sync map's, and it did not move.
      const again = ctx.gateway.stageImportFile(ctx.owner, {
        filename: "bank-a-june.csv",
        data: STATEMENT,
        accountName: "Bank A Savings",
        currency: "INR",
      });
      const accounts = ctx
        .rows<{ account: string }>(
          `SELECT a.name AS account FROM core_transaction t
             JOIN core_account a ON a.account_id = t.account_id
            WHERE t.external_id = 'ref-1' ORDER BY a.name`
        )
        .map((row) => row.account);
      const mappings = ctx.row<{ connections: number; rows_mapped: number }>(
        `SELECT count(DISTINCT connection_id) AS connections, count(*) AS rows_mapped
           FROM sync_external_entity
          WHERE external_id = 'ref-1' AND target_type = 'core.transaction'`
      )!;
      return [
        {
          claim: "each bank's statement creates its own line",
          actual: [first.published.created, second.published.created],
          expected: [1, 1],
        },
        {
          claim: "`ref-1` names one row per source",
          actual: accounts,
          expected: ["Bank A Savings", "Bank B Current"],
        },
        {
          claim: "the identity claim is per connection",
          actual: [mappings.connections, mappings.rows_mapped],
          expected: [2, 2],
        },
        {
          claim: "re-importing the same source changes nothing",
          actual: again.staged.create,
          expected: 0,
        },
      ];
    },
  },
  {
    id: "ONT-22/a-revision-is-an-occurrence",
    drift: "ONT-22",
    title: "two documents with identical bytes keep separate histories",
    surfaces: ["Docs — the version history", "Docs — restore"],
    run(ctx): ScenarioCheck[] {
      const history = (documentId: string): string[] =>
        ctx
          .rows<{ content_id: string }>(
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
             SELECT content_id FROM chain ORDER BY depth DESC`,
            documentId
          )
          .map((row) => row.content_id);
      const add = (title: string, text: string) =>
        ctx.execute<{ document_id: string; content_id: string }>(
          "core.add_document",
          { title, data_uri: bodyUri(text) }
        );
      const edit = (documentId: string, text: string): string =>
        ctx.execute<{ content_id: string }>("core.edit_document", {
          document_id: documentId,
          body_text: text,
        }).content_id;

      const first = add("Template A.txt", "the same words");
      const second = add("Template B.txt", "the same words");
      const firstV2 = edit(first.document_id, "A goes its own way");
      // A→B→A→B on a third document: two content ids, four occurrences.
      const third = add("Doc.txt", "A");
      const b = edit(third.document_id, "B");
      const backToA = edit(third.document_id, "A");
      const restore = ctx.invoke("core.restore_document_version", {
        document_id: first.document_id,
        content_id: b,
      });
      return [
        {
          claim: "the bytes still dedupe",
          actual: second.content_id,
          expected: first.content_id,
        },
        {
          claim: "A's edit is A's history",
          actual: history(first.document_id),
          expected: [first.content_id, firstV2],
        },
        {
          claim: "B is untouched by A's edit",
          actual: history(second.document_id),
          expected: [second.content_id],
        },
        {
          claim: "A→B→A is three occurrences over two content ids",
          actual: history(third.document_id),
          expected: [third.content_id, b, backToA],
        },
        {
          claim: "restoring another document's revision is refused",
          actual: restore.status,
          expected: "failed",
        },
      ];
    },
  },
  {
    id: "ONT-28/an-interpretation-is-not-a-property-of-bytes",
    drift: "ONT-28",
    title: "one byte row, two documents, two readings",
    surfaces: ["Docs — the document body", "Photos — the asset's reading"],
    run(ctx): ScenarioCheck[] {
      const asHtml = ctx.execute<{ document_id: string; content_id: string }>(
        "core.add_document",
        { data_uri: AS_HTML, title: "Ship it (page)" }
      );
      const asText = ctx.execute<{
        document_id: string;
        content_id: string;
        deduped: number;
      }>("core.add_document", { data_uri: AS_TEXT, title: "Ship it (notes)" });
      const mediaTypeColumn = ctx.rows<{ name: string }>(
        "SELECT name FROM pragma_table_info('core_content_item') WHERE name = 'media_type'"
      );
      return [
        {
          claim: "one byte row under two documents",
          actual: [asText.content_id === asHtml.content_id, asText.deduped],
          expected: [true, 1],
        },
        {
          claim: "each document reads the bytes its own way",
          actual: [
            mediaTypeOfOwner(ctx.db.vault, {
              ownerType: "core.document",
              ownerId: asHtml.document_id,
            }),
            mediaTypeOfOwner(ctx.db.vault, {
              ownerType: "core.document",
              ownerId: asText.document_id,
            }),
          ],
          expected: ["text/html", "text/plain"],
        },
        {
          claim: "the byte row has no reading of its own",
          actual: mediaTypeColumn.length,
          expected: 0,
        },
      ];
    },
  },
];
