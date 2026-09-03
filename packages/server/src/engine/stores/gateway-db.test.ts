import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openLedgerDb, makeLedgerDbProvider } from "./gateway-db.js";
import { ledgerDbFileIn } from "./ledger-db.test-fixtures.js";

function freshDbPath(): string {
  return ledgerDbFileIn(tempDirSync("centraid-db-"));
}

function barePath(): string {
  return path.join(tempDirSync("centraid-bare-db-"), "db.sqlite");
}

const LEDGER_TABLES = [
  "attachments",
  "automation_state",
  "automation_trigger_cursor",
  "conversation_archive",
  "conversation_digest",
  "conversation_harness_sessions",
  "conversation_provider_consent",
  "conversation_turn_locks",
  "conversation_workspace_selection",
  "conversations",
  "harness_health",
  "items",
  "trigger_ingress",
  "turns",
];

function userVersion(pathLocal: string): number {
  const db = new DatabaseSync(pathLocal);
  try {
    const row = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    return row.user_version;
  } finally {
    db.close();
  }
}

function tableNames(pathLocal: string): string[] {
  const db = new DatabaseSync(pathLocal);
  try {
    return (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
        )
        .all() as Array<{
        name: string;
      }>
    )
      .map((t) => t.name)
      .filter((n) => !n.startsWith("sqlite_"));
  } finally {
    db.close();
  }
}

describe("openLedgerDb (the conversation-ledger band of vault.db)", () => {
  it("uses the bounded low-end read pragmas (#456 S1)", () => {
    const db = openLedgerDb(barePath());
    try {
      expect({ ...db.prepare("PRAGMA cache_size").get() }).toStrictEqual({
        cache_size: -16000,
      });
      expect({ ...db.prepare("PRAGMA mmap_size").get() }).toStrictEqual({
        mmap_size: 67_108_864,
      });
      expect({ ...db.prepare("PRAGMA temp_store").get() }).toStrictEqual({
        temp_store: 2,
      });
    } finally {
      db.close();
    }
  });

  it("ISSUES NO DDL — the vault composed the band, and the ladder is its own", () => {
    const pathLocal = freshDbPath();
    const before = userVersion(pathLocal);
    expect(before).toBe(1);
    openLedgerDb(pathLocal).close();
    expect(userVersion(pathLocal)).toBe(before);
    const bare = barePath();
    openLedgerDb(bare).close();
    expect(tableNames(bare)).toStrictEqual([]);
  });

  it("the band the vault composes carries every table, view and trigger the stores read", () => {
    const pathLocal = freshDbPath();
    const present = new Set(tableNames(pathLocal));
    expect(LEDGER_TABLES.filter((t) => present.has(t))).toStrictEqual(
      LEDGER_TABLES
    );
    expect(present.has("fts_conversation")).toBe(true);
    const db = new DatabaseSync(pathLocal);
    try {
      const views = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='view' ORDER BY name`
        )
        .all() as Array<{ name: string }>;
      expect(views.map((v) => v.name)).toContain("run_summary");
      const triggers = new Set(
        (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`
            )
            .all() as Array<{ name: string }>
        ).map((t) => t.name)
      );
      const ledgerTriggers = [
        "conversation_item_count_ad",
        "conversation_item_count_ai",
        "fts_conversation_conv_ad",
        "fts_conversation_conv_ai",
        "fts_conversation_conv_au",
        "fts_conversation_item_ad",
        "fts_conversation_item_ai",
        "fts_conversation_turn_ad",
      ];
      expect(ledgerTriggers.filter((t) => triggers.has(t))).toStrictEqual(
        ledgerTriggers
      );
    } finally {
      db.close();
    }
  });

  it("conversations has NO foreign key (user_id carries the vault owner party id)", () => {
    const pathLocal = freshDbPath();
    openLedgerDb(pathLocal).close();
    const db = new DatabaseSync(pathLocal);
    try {
      expect(
        db.prepare(`PRAGMA foreign_key_list('conversations')`).all()
      ).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("turns→conversations and items→turns and attachments→items are CASCADE FKs", () => {
    const pathLocal = freshDbPath();
    openLedgerDb(pathLocal).close();
    const db = new DatabaseSync(pathLocal);
    try {
      const fk = (table: string, parent: string) =>
        (
          db.prepare(`PRAGMA foreign_key_list('${table}')`).all() as Array<{
            table: string;
            on_delete: string;
          }>
        ).find((f) => f.table === parent);
      expect(fk("turns", "conversations")?.on_delete).toBe("CASCADE");
      expect(fk("items", "turns")?.on_delete).toBe("CASCADE");
      expect(fk("attachments", "items")?.on_delete).toBe("CASCADE");
      const turnFks = db
        .prepare(`PRAGMA foreign_key_list('turns')`)
        .all() as Array<{
        from: string;
      }>;
      expect(!turnFks.some((f) => f.from === "parent_turn_id")).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("deleting a conversation cascades to its turns, items, and attachments", () => {
    const pathLocal = freshDbPath();
    const db = openLedgerDb(pathLocal);
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO conversations (id, kind, user_id, created_at, updated_at)
         VALUES ('c1', 'chat', 'u1', ?, ?)`
      ).run(now, now);
      db.prepare(
        `INSERT INTO turns (id, conversation_id, seq, trigger, started_at)
         VALUES ('t1', 'c1', 0, 'interactive', ?)`
      ).run(now);
      db.prepare(
        `INSERT INTO items (id, turn_id, ordinal, kind, role, text, started_at)
         VALUES ('i1', 't1', 0, 'message_in', 'user', 'hi', ?)`
      ).run(now);
      db.prepare(
        `INSERT INTO attachments (id, item_id, hash, mime, size_bytes, created_at)
         VALUES ('a1', 'i1', 'deadbeef', 'image/png', 10, ?)`
      ).run(now);

      db.prepare(`DELETE FROM conversations WHERE id = 'c1'`).run();
      for (const table of ["turns", "items", "attachments"]) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        };
        expect(Number(n.n)).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it("CHECK constraints reject unknown conversation kind / turn trigger / item kind", () => {
    const pathLocal = freshDbPath();
    const db = openLedgerDb(pathLocal);
    try {
      const now = Date.now();
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversations (id, kind, user_id, created_at, updated_at) VALUES ('c', 'bogus', 'u', ?, ?)`
          )
          .run(now, now)
      ).toThrow(/CHECK/iu);
      db.prepare(
        `INSERT INTO conversations (id, kind, user_id, created_at, updated_at) VALUES ('c1','chat','u',?,?)`
      ).run(now, now);
      expect(() =>
        db
          .prepare(
            `INSERT INTO turns (id, conversation_id, seq, trigger, started_at) VALUES ('t','c1',0,'bogus',?)`
          )
          .run(now)
      ).toThrow(/CHECK/iu);
      db.prepare(
        `INSERT INTO turns (id, conversation_id, seq, trigger, started_at) VALUES ('t1','c1',0,'interactive',?)`
      ).run(now);
      expect(() =>
        db
          .prepare(
            `INSERT INTO items (id, turn_id, ordinal, kind, started_at) VALUES ('i','t1',0,'bogus',?)`
          )
          .run(now)
      ).toThrow(/CHECK/iu);
    } finally {
      db.close();
    }
  });

  it("re-opening an already-ensured DB is a no-op (rows survive)", () => {
    const pathLocal = freshDbPath();
    const first = openLedgerDb(pathLocal);
    const now = Date.now();
    first
      .prepare(
        `INSERT INTO conversations (id, kind, user_id, created_at, updated_at)
         VALUES ('c1', 'chat', 'u1', ?, ?)`
      )
      .run(now, now);
    first.close();
    const again = openLedgerDb(pathLocal);
    try {
      const n = again
        .prepare("SELECT COUNT(*) AS n FROM conversations")
        .get() as { n: number };
      expect(Number(n.n)).toBe(1);
    } finally {
      again.close();
    }
  });

  it("converts a pre-#438 file (auto_vacuum=0) to INCREMENTAL on open (issue #438)", () => {
    const pathLocal = barePath();
    const seed = new DatabaseSync(pathLocal);
    seed.exec("PRAGMA journal_mode=WAL");
    seed.exec("CREATE TABLE legacy(a TEXT)");
    const ins = seed.prepare("INSERT INTO legacy VALUES (?)");
    for (let i = 0; i < 300; i++) ins.run("x".repeat(300));
    seed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(
      (seed.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number })
        .auto_vacuum
    ).toBe(0);
    seed.close();

    const db = openLedgerDb(pathLocal);
    try {
      expect(
        (db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number })
          .auto_vacuum
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  it("conversation_archive and conversation_digest CASCADE-delete with their conversation (issue #438)", () => {
    const pathLocal = freshDbPath();
    const db = openLedgerDb(pathLocal);
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO conversations (id, kind, user_id, created_at, updated_at)
         VALUES ('c1', 'chat', 'u1', ?, ?)`
      ).run(now, now);
      db.prepare(
        `INSERT INTO conversation_archive
           (id, conversation_id, seq_from, seq_to, from_time, to_time, turn_count, item_count,
            segment_sha256, segment_bytes, plaintext_bytes, created_at)
         VALUES ('ar1', 'c1', 0, 9, ?, ?, 10, 20, ?, 100, 200, ?)`
      ).run(now, now, "a".repeat(64), now);
      db.prepare(
        `INSERT INTO conversation_digest (conversation_id, kind, updated_at)
         VALUES ('c1', 'chat', ?)`
      ).run(now);

      db.prepare(`DELETE FROM conversations WHERE id = 'c1'`).run();
      for (const table of ["conversation_archive", "conversation_digest"]) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        };
        expect(Number(n.n)).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it("conversation_archive rejects a non-64-char segment_sha256 (issue #438)", () => {
    const pathLocal = freshDbPath();
    const db = openLedgerDb(pathLocal);
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO conversations (id, kind, user_id, created_at, updated_at)
         VALUES ('c1', 'chat', 'u1', ?, ?)`
      ).run(now, now);
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversation_archive
               (id, conversation_id, seq_from, seq_to, from_time, to_time, turn_count, item_count,
                segment_sha256, segment_bytes, plaintext_bytes, created_at)
             VALUES ('ar1', 'c1', 0, 9, ?, ?, 10, 20, 'tooshort', 100, 200, ?)`
          )
          .run(now, now, now)
      ).toThrow(/CHECK/iu);
    } finally {
      db.close();
    }
  });
});

describe("STRICT tables (issue #374 SQLite hardening)", () => {
  it("every ledger table is created STRICT", () => {
    const pathLocal = freshDbPath();
    openLedgerDb(pathLocal).close();
    const db = new DatabaseSync(pathLocal);
    try {
      const rows = db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string; sql: string }>;
      for (const table of [
        "conversations",
        "turns",
        "items",
        "attachments",
        "automation_state",
      ]) {
        const row = rows.find((r) => r.name === table);
        expect(row?.sql.trim().endsWith("STRICT")).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("rejects a type-violating insert (STRICT enforcement)", () => {
    const pathLocal = freshDbPath();
    const db = openLedgerDb(pathLocal);
    try {
      const now = Date.now();
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversations (id, kind, user_id, turn_count, created_at, updated_at)
             VALUES ('c1', 'chat', 'u1', 'not-a-number', ?, ?)`
          )
          .run(now, now)
      ).toThrow(/cannot store TEXT value in INTEGER column/u);
    } finally {
      db.close();
    }
  });
});

describe("lazy provider", () => {
  it("opens the DB once and reuses the handle for subsequent calls", () => {
    const provider = makeLedgerDbProvider(freshDbPath());
    const a = provider();
    const b = provider();
    expect(a).toBe(b);
    a.close();
  });

  it("does not touch the filesystem until the first call", () => {
    const pathLocal = barePath();
    makeLedgerDbProvider(pathLocal);
    expect(existsSync(pathLocal)).toBe(false);
  });
});
