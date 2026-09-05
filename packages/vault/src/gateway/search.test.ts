// The search stage: FTS5 shadow tables under read's consent posture, plus the
// two clamps search adds (folded-in content consent, field masks).

import { beforeEach, describe, expect, test } from "vitest";

import { seededRandom } from "@centraid/test-kit/random";

import { bootstrapVault, enrollAgent } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerKnowledgeCommands } from "../commands/knowledge.js";
import { registerPeopleCommands } from "../commands/people.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { answerScopes } from "../grant/automation-principal.test-fixtures.js";
import type { Gateway } from "./gateway.js";
import { createGateway } from "./gateway.js";
import { ftsMatchExpression } from "./search.js";
import type { Credential, ExecutionScopeSpec } from "./types.js";

const rng = seededRandom(0x5ea_2c_41);

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

function createNote(title: string, body: string): string {
  const outcome = gw.invoke(owner, {
    command: "knowledge.create_note",
    input: { title, body_text: body },
  });
  if (outcome.status !== "executed")
    throw new Error(`create_note ${outcome.status}`);
  return (outcome.output as { note_id: string }).note_id;
}

function execOut<T>(command: string, input: Record<string, unknown>): T {
  const outcome = gw.invoke(owner, { command, input });
  if (outcome.status !== "executed")
    throw new Error(`${command} ${outcome.status}`);
  return outcome.output as T;
}

/**
 * An automation the owner answered YES for, run under a per-execution clamp.
 * The answer says WHETHER it reaches the entity; the clamp is the only thing
 * that narrows which rows and which fields (#928).
 */
function appCred(
  scopes: readonly ExecutionScopeSpec[],
  clamped = false
): Credential {
  const name = `app-${rng.token(6)}`;
  const app = enrollAgent(db, { name, modelRef: "test-automation" });
  answerScopes(
    db,
    boot,
    name,
    scopes.map((scope) => ({
      schema: scope.schema,
      ...(scope.table === undefined ? {} : { table: scope.table }),
      verbs: scope.verbs,
    }))
  );
  return {
    kind: "agent",
    agentId: app.agentId,
    deviceId: boot.deviceId,
    deviceKey: boot.deviceKey,
    ...(clamped ? { scopeClamp: scopes } : {}),
  };
}

describe("search", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerKnowledgeCommands(gw);
    registerPeopleCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  describe("match expression", () => {
    test("words become quoted prefix phrases, operators become literals", () => {
      expect(ftsMatchExpression("budget plan")).toBe('"budget"* "plan"*');
      expect(ftsMatchExpression('a AND b NEAR( "x')).toBe(
        '"a"* "AND"* "b"* "NEAR("* "x"*'
      );
    });

    test("nothing searchable → null", () => {
      expect(ftsMatchExpression("   ")).toBeNull();
      expect(ftsMatchExpression('- " ~~')).toBeNull();
    });
  });

  describe("index-backed matching", () => {
    test("matches photo captions on content items and excludes soft-deleted bytes", () => {
      const insert = db.vault.prepare(
        `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, created_at)
       VALUES (?, 'image/jpeg', ?, ?, 4, ?, ?)`
      );
      insert.run(
        "photo-caption",
        "data:image/jpeg;base64,dGVzdA==",
        "hash-photo-caption",
        "Moonlit campsite in Ladakh",
        "2026-07-15T00:00:00.000Z"
      );
      expect(
        gw
          .search(owner, {
            entity: "core.content_item",
            query: "moon camp",
          })
          .rows.map((row) => row.content_id)
      ).toStrictEqual(["photo-caption"]);
      db.vault
        .prepare(
          `UPDATE core_content_item SET deleted_at = ? WHERE content_id = ?`
        )
        .run("2026-07-15T01:00:00.000Z", "photo-caption");
      expect(
        gw.search(owner, {
          entity: "core.content_item",
          query: "moon",
        }).rows
      ).toHaveLength(0);
    });

    test("breaks equal-rank search ties by the canonical primary key", () => {
      const insert = db.vault.prepare(
        `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, created_at)
       VALUES (?, 'image/jpeg', ?, ?, 4, 'Same caption', ?)`
      );
      // Reverse insertion order catches an implicit-order plan at LIMIT 1.
      insert.run(
        "photo-b",
        "data:image/jpeg;base64,Yg==",
        "hash-photo-b",
        "2026-07-15T00:00:00.000Z"
      );
      insert.run(
        "photo-a",
        "data:image/jpeg;base64,YQ==",
        "hash-photo-a",
        "2026-07-15T00:00:01.000Z"
      );
      expect(
        gw
          .search(owner, {
            entity: "core.content_item",
            query: "same",
            limit: 1,
          })
          .rows.map((row) => row.content_id)
      ).toStrictEqual(["photo-a"]);
    });

    test("a People interaction annotation is searchable through the canonical command layer (issue #450)", () => {
      // The interaction body must reach search.
      const { party_id } = execOut<{ party_id: string }>("people.add_person", {
        display_name: "Ravi",
        cadence_days: 30,
      });
      const { interaction_id } = execOut<{ interaction_id: string }>(
        "people.log_interaction",
        {
          party_id,
          kind: "call",
          text: "talked about the Ladakh trek plans",
        }
      );

      const hits = gw.search(owner, {
        entity: "knowledge.annotation",
        query: "ladakh trek",
      }).rows;
      expect(hits.map((r) => r.target_id)).toContain(interaction_id);
    });

    test("People canonical gift tasks and journal notes are searchable too (issue #450)", () => {
      const { party_id } = execOut<{ party_id: string }>("people.add_person", {
        display_name: "Ravi",
        cadence_days: 30,
      });
      const { gift_id } = execOut<{ gift_id: string }>("people.add_gift", {
        party_id,
        text: "a handmade ceramic mug",
      });
      expect(
        gw
          .search(owner, {
            entity: "schedule.task",
            query: "ceramic mug",
          })
          .rows.map((r) => r.task_id)
      ).toContain(gift_id);

      const { entry_id } = execOut<{ entry_id: string }>(
        "people.add_journal_entry",
        {
          entry_date: "2026-07-17",
          mood: "grateful",
          text: "a quiet morning writing",
        }
      );
      expect(
        gw
          .search(owner, {
            entity: "knowledge.note",
            query: "quiet morning",
          })
          .rows.map((r) => r.note_id)
      ).toContain(entry_id);
    });

    test("matches title and canonical body, ranked, with a snippet", () => {
      createNote("Money things", "the quarterly budget plan for Diwali");
      createNote("Shopping", "grocery list: dal, rice");
      const result = gw.search(owner, {
        entity: "knowledge.note",
        query: "budget",
      });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.title).toBe("Money things");
      expect(result.rows[0]?._snippet).toContain("⟦budget⟧");
      // Owner-direct: no receipt (#928); a non-owner search still leaves one,
      // asserted in the automation cases below.
      expect(result.receiptId).toBeUndefined();
    });

    test("prefix matching serves as-you-type search", () => {
      createNote("Money things", "the quarterly budget plan");
      const result = gw.search(owner, {
        entity: "knowledge.note",
        query: "budg",
      });
      expect(result.rows).toHaveLength(1);
    });

    test("edits re-index; deletes drop out", () => {
      const noteId = createNote("Money things", "the quarterly budget plan");
      gw.invoke(owner, {
        command: "knowledge.edit_note",
        input: { note_id: noteId, body_text: "now all about pottery glaze" },
      });
      const q = (query: string) =>
        gw.search(owner, { entity: "knowledge.note", query }).rows.length;
      expect(q("budget")).toBe(0);
      expect(q("pottery")).toBe(1);
      gw.invoke(owner, {
        command: "knowledge.delete_note",
        input: { note_id: noteId },
      });
      expect(q("pottery")).toBe(0);
    });

    test("caller where-clauses AND with the match", () => {
      const pinnedId = createNote("Pinned budget", "budget A");
      createNote("Unpinned budget", "budget B");
      gw.invoke(owner, {
        command: "knowledge.edit_note",
        input: { note_id: pinnedId, pinned: 1 },
      });
      const result = gw.search(owner, {
        entity: "knowledge.note",
        query: "budget",
        where: [{ column: "pinned", op: "eq", value: 1 }],
      });
      expect(result.rows.map((r) => r.note_id)).toStrictEqual([pinnedId]);
    });

    test("FTS operators in owner text never become syntax", () => {
      createNote("Ops", "NEAR the AND river");
      const result = gw.search(owner, {
        entity: "knowledge.note",
        query: '"NEAR( AND',
      });
      expect(result.rows).toHaveLength(1);
    });
  });

  describe("contract clamps", () => {
    test("non-indexed entity is a contract error, not a scan", () => {
      expect(() =>
        gw.search(owner, {
          entity: "media.asset",
          query: "x",
        })
      ).toThrow(/not text-searchable/u);
    });

    test("empty query is a contract error", () => {
      expect(() =>
        gw.search(owner, {
          entity: "knowledge.note",
          query: "  ",
        })
      ).toThrow(/no searchable words/u);
    });
  });

  describe("consent clamps", () => {
    test("ungranted app is denied with a receipt", () => {
      const app = enrollAgent(db, {
        name: "nosy-app",
        modelRef: "test-automation",
      });
      const cred: Credential = {
        kind: "agent",
        agentId: app.agentId,
        deviceId: boot.deviceId,
        deviceKey: boot.deviceKey,
      };
      expect(() =>
        gw.search(cred, {
          entity: "knowledge.note",
          query: "budget",
        })
      ).toThrow(/deny/u);
      const deny = db.audit
        .prepare(
          `SELECT count(*) AS n FROM access_receipt WHERE decision='deny' AND action='search'`
        )
        .get() as { n: number };
      expect(deny.n).toBe(1);
    });

    test("note-body search needs read consent on core.content_item too", () => {
      createNote("Money things", "the quarterly budget plan");
      const cred = appCred([{ schema: "knowledge", verbs: "read" }]);
      expect(() =>
        gw.search(cred, {
          entity: "knowledge.note",
          query: "budget",
        })
      ).toThrow(/core\.content_item/u);
      const granted = appCred([
        { schema: "knowledge", verbs: "read" },
        { schema: "core", table: "content_item", verbs: "read" },
      ]);
      expect(
        gw.search(granted, {
          entity: "knowledge.note",
          query: "budget",
        }).rows
      ).toHaveLength(1);
    });

    test("clamp row filters clamp matches", () => {
      createNote("Pinned budget", "budget A");
      const cred = appCred(
        [
          {
            schema: "knowledge",
            verbs: "read",
            rowFilter: [{ column: "pinned", op: "eq", value: 1 }],
          },
          { schema: "core", table: "content_item", verbs: "read" },
        ],
        true
      );
      expect(
        gw.search(cred, {
          entity: "knowledge.note",
          query: "budget",
        }).rows
      ).toHaveLength(0);
    });

    test("a field mask hiding an indexed column fails the search closed", () => {
      createNote("Money things", "the quarterly budget plan");
      const cred = appCred(
        [
          {
            schema: "knowledge",
            verbs: "read",
            fieldMask: ["note_id", "body_content_id"],
          },
          { schema: "core", table: "content_item", verbs: "read" },
        ],
        true
      );
      expect(() =>
        gw.search(cred, {
          entity: "knowledge.note",
          query: "budget",
        })
      ).toThrow(/field mask hides indexed column/u);
    });
  });

  // A two-column direct surface keeping disposed rows in the index is covered
  // by `core.party` and `locker.item` above (#883).

  describe("pre-index vaults", () => {
    test("v1→v2 migration backfills existing rows into the index", () => {
      // Simulates a vault whose base rows predate the shadow tables.
      createNote("Old note", "archaeology of budgets");
      db.vault.exec(`DELETE FROM fts_knowledge_note`);
      expect(
        gw.search(owner, {
          entity: "knowledge.note",
          query: "archaeology",
        }).rows
      ).toHaveLength(0);
      db.vault.exec(
        `INSERT INTO fts_knowledge_note(rowid, note_id, title, body)
       SELECT b.rowid, b."note_id", b."title",
              (SELECT vault_content_text(media_type, content_uri) FROM core_content_item
                WHERE content_id = b."body_content_id")
         FROM knowledge_note b`
      );
      expect(
        gw.search(owner, {
          entity: "knowledge.note",
          query: "archaeology",
        }).rows
      ).toHaveLength(1);
    });
  });
});
