import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { makeLedgerDbProvider } from "../stores/gateway-db.js";
import { ledgerDbFileIn } from "../stores/ledger-db.test-fixtures.js";
import type { WorkspaceProvider } from "../stores/vault-workspace.js";
import { ConversationHistoryStore } from "./history.js";
import { repriceLedger } from "./reprice.js";

const APP = "todos";
const OWNER = "test-owner-uuid-0000";

const MODEL = "claude-haiku-4-5";
const EXPECTED = 1;

function freshVaultDir(): string {
  const dir = tempDirSync("centraid-reprice-");
  mkdirSync(path.join(dir, "apps", APP), { recursive: true });
  return dir;
}

describe(repriceLedger, () => {
  let dir: string;
  let db: DatabaseSync;
  let store: ConversationHistoryStore;

  beforeEach(() => {
    dir = freshVaultDir();
    const journal = makeLedgerDbProvider(ledgerDbFileIn(dir));
    db = journal();
    const workspace: WorkspaceProvider = () => ({
      vaultId: "vault-test",
      ownerPartyId: OWNER,
      appsDir: path.join(dir, "apps"),
      journal,
      ledgerDbFile: ledgerDbFileIn(dir),
      harnessSessionDir: path.join(dir, "harness-sessions"),
    });
    store = new ConversationHistoryStore(workspace);
  });

  function recordStep(): string {
    const s = store.createSession(APP);
    const r = store.recordTurn(APP, {
      conversationId: s.id,
      userMessage: "q",
      startedAt: 1_000,
      endedAt: 1_020,
      ok: true,
      finalText: "a",
      nodes: [
        {
          kind: "step",
          text: "a",
          model: MODEL,
          inputTokens: 1_000_000,
          startedAt: 1_000,
          endedAt: 1_010,
        },
      ],
    });
    return r!.turnId;
  }

  it("reprices a NULL-cost item and re-derives the turn total", () => {
    const turnId = recordStep();
    db.prepare(`UPDATE items SET cost_usd = NULL WHERE kind = 'step'`).run();
    db.prepare(`UPDATE turns SET total_cost_usd = NULL WHERE id = ?`).run(
      turnId
    );

    const result = repriceLedger(db);
    expect(result.itemsRepriced).toBe(1);
    expect(result.turnsRederived).toBe(1);

    const item = db
      .prepare(`SELECT cost_usd FROM items WHERE kind = 'step'`)
      .get() as {
      cost_usd: number | null;
    };
    expect(item.cost_usd).toBeCloseTo(EXPECTED, 9);
    const turn = db
      .prepare(`SELECT total_cost_usd FROM turns WHERE id = ?`)
      .get(turnId) as {
      total_cost_usd: number | null;
    };
    expect(turn.total_cost_usd).toBeCloseTo(EXPECTED, 9);
  });

  it("reprices a drifted (stale-rate) item", () => {
    recordStep();
    db.prepare(`UPDATE items SET cost_usd = 999 WHERE kind = 'step'`).run();
    const result = repriceLedger(db);
    expect(result.itemsRepriced).toBe(1);
    const item = db
      .prepare(`SELECT cost_usd FROM items WHERE kind = 'step'`)
      .get() as {
      cost_usd: number | null;
    };
    expect(item.cost_usd).toBeCloseTo(EXPECTED, 9);
  });

  it("never touches token columns", () => {
    recordStep();
    db.prepare(`UPDATE items SET cost_usd = NULL WHERE kind = 'step'`).run();
    repriceLedger(db);
    const item = db
      .prepare(`SELECT input_tokens FROM items WHERE kind = 'step'`)
      .get() as {
      input_tokens: number | null;
    };
    expect(item.input_tokens).toBe(1_000_000);
  });

  it("is idempotent — a second pass over correctly-priced rows is a no-op", () => {
    recordStep();
    db.prepare(`UPDATE items SET cost_usd = NULL WHERE kind = 'step'`).run();
    expect(repriceLedger(db).itemsRepriced).toBe(1);
    expect(repriceLedger(db).itemsRepriced).toBe(0);
  });

  it("respects the write cap and resumes from the returned cursor", () => {
    for (let i = 0; i < 4; i += 1) recordStep();
    db.prepare(`UPDATE items SET cost_usd = NULL WHERE kind = 'step'`).run();

    const first = repriceLedger(db, { maxWrites: 1, maxScan: 100 });
    expect(first.itemsRepriced).toBe(1);
    expect(first.nextCursor).toBeGreaterThan(0);

    const second = repriceLedger(db, {
      cursor: first.nextCursor,
      maxWrites: 10,
    });
    expect(second.itemsRepriced).toBe(3);
    const remaining = db
      .prepare(
        `SELECT COUNT(*) AS n FROM items WHERE kind = 'step' AND cost_usd IS NULL`
      )
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("never overwrites harness-reported costs (#514)", () => {
    recordStep();
    db.prepare(
      `UPDATE items SET cost_usd = 0.42, cost_source = 'harness' WHERE kind = 'step'`
    ).run();
    const result = repriceLedger(db);
    expect(result.itemsRepriced).toBe(0);
    const item = db
      .prepare(`SELECT cost_usd, cost_source FROM items WHERE kind = 'step'`)
      .get() as {
      cost_usd: number | null;
      cost_source: string | null;
    };
    expect(item.cost_usd).toBeCloseTo(0.42, 9);
    expect(item.cost_source).toBe("harness");
  });

  it("leaves conversation_digest rows untouched (frozen #438 rollups are out of scope)", () => {
    recordStep();
    db.prepare(`UPDATE items SET cost_usd = NULL WHERE kind = 'step'`).run();
    const convId = (
      db.prepare(`SELECT id FROM conversations LIMIT 1`).get() as { id: string }
    ).id;
    db.prepare(
      `INSERT INTO conversation_digest
        (conversation_id, app_id, kind, run_count, retry_count, first_started_at,
         last_ended_at, total_cost_usd, updated_at)
       VALUES (?, 'todos', 'chat', 3, 0, 1, 2, 999, 2)`
    ).run(convId);

    repriceLedger(db);
    const digest = db
      .prepare(
        `SELECT total_cost_usd FROM conversation_digest WHERE conversation_id = ?`
      )
      .get(convId) as { total_cost_usd: number };
    expect(digest.total_cost_usd).toBe(999);
  });
});
