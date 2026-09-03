import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { makeConversationRouteHandler } from "../http/conversation-routes.js";
import { makeLedgerDbProvider } from "../stores/gateway-db.js";
import type { DatabaseProvider } from "../stores/gateway-db.js";
import { ledgerDbFileIn } from "../stores/ledger-db.test-fixtures.js";
import type { WorkspaceProvider } from "../stores/vault-workspace.js";
import { runConversationArchival } from "./archive/index.js";
import type { BlobSink } from "./archive/types.js";
import { ConversationHistoryStore } from "./history.js";
import type { ArchiveBlobReader } from "./rehydrate.js";

const USER = "owner-party-0000";
const APP = "assistant";
const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const daysAgo = (d: number): number => now - d * DAY_MS;

class MemoryBlobSink implements BlobSink {
  readonly store = new Map<string, Buffer>();
  ingestSync(bytes: Buffer): { sha256: string; byteSize: number } {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!this.store.has(sha256)) this.store.set(sha256, Buffer.from(bytes));
    return { sha256, byteSize: bytes.length };
  }
  has(sha: string): boolean {
    return this.store.has(sha);
  }
  get(sha: string): Buffer | undefined {
    return this.store.get(sha);
  }
}

function freshVaultDir(): string {
  const dir = tempDirSync("centraid-rehydrate-");
  mkdirSync(path.join(dir, "apps", APP), { recursive: true });
  return dir;
}

function workspaceFor(
  provider: DatabaseProvider,
  dir: string
): WorkspaceProvider {
  return () => ({
    vaultId: "vault-test",
    ownerPartyId: USER,
    appsDir: path.join(dir, "apps"),
    journal: provider,
    ledgerDbFile: ledgerDbFileIn(dir),
    harnessSessionDir: path.join(dir, "harness-sessions"),
  });
}

function seedConversation(
  journal: DatabaseSync,
  id: string,
  kind: "chat" | "automation"
): void {
  journal
    .prepare(
      `INSERT INTO conversations (id, kind, user_id, app_id, automation_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Thread', ?, ?)`
    )
    .run(
      id,
      kind,
      USER,
      APP,
      kind === "automation" ? id : null,
      daysAgo(200),
      daysAgo(100)
    );
}

function seedTurn(
  journal: DatabaseSync,
  a: {
    conversationId: string;
    turnId: string;
    seq: number;
    startedAt: number;
    reply: string;
    attachmentHash?: string;
  }
): void {
  journal
    .prepare(
      `INSERT INTO turns (id, conversation_id, seq, trigger, ok, started_at, ended_at,
         total_input_tokens, total_output_tokens, total_cost_usd, step_count)
       VALUES (?, ?, ?, 'interactive', 1, ?, ?, 10, 20, 0.5, 1)`
    )
    .run(a.turnId, a.conversationId, a.seq, a.startedAt, a.startedAt + 1000);
  journal
    .prepare(
      `INSERT INTO items (id, turn_id, ordinal, kind, role, text, ok, started_at)
       VALUES (?, ?, 0, 'message_in', 'user', ?, 1, ?)`
    )
    .run(`${a.turnId}-msg`, a.turnId, `ask ${a.seq}`, a.startedAt);
  journal
    .prepare(
      `INSERT INTO items (id, turn_id, ordinal, kind, model, output_json, ok, started_at)
       VALUES (?, ?, 1, 'step', 'model-x', ?, 1, ?)`
    )
    .run(
      `${a.turnId}-step`,
      a.turnId,
      JSON.stringify({ text: a.reply }),
      a.startedAt
    );
  if (a.attachmentHash) {
    journal
      .prepare(
        `INSERT INTO attachments (id, item_id, hash, mime, size_bytes, filename, created_at)
         VALUES (?, ?, ?, 'image/png', 12, 'pic.png', ?)`
      )
      .run(`${a.turnId}-att`, `${a.turnId}-msg`, a.attachmentHash, a.startedAt);
  }
}

interface Fixture {
  journal: DatabaseSync;
  sink: MemoryBlobSink;
  reads: string[];
  reader: ArchiveBlobReader;
  store: (reader?: ArchiveBlobReader) => ConversationHistoryStore;
}

function fixture(): Fixture {
  const dir = freshVaultDir();
  const provider = makeLedgerDbProvider(ledgerDbFileIn(dir));
  const sink = new MemoryBlobSink();
  const reads: string[] = [];
  const reader: ArchiveBlobReader = async (sha) => {
    reads.push(sha);
    return sink.get(sha) ?? null;
  };
  return {
    journal: provider(),
    sink,
    reads,
    reader,
    store: (r = reader) =>
      new ConversationHistoryStore(workspaceFor(provider, dir), {
        archiveBlobReader: r,
      }),
  };
}

function withoutMarker(
  messages: Array<{ payload: unknown; createdAt: number }>
): unknown[] {
  return messages.map((m) => {
    const { fromArchive: _fromArchive, ...rest } = m.payload as Record<
      string,
      unknown
    >;
    return { payload: rest, createdAt: m.createdAt };
  });
}

describe("conversation rehydration (issue #438 wave 3)", () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });

  it("windows and pages across the archive boundary, not just the live rows", async () => {
    const store = f.store();
    seedConversation(f.journal, "c1", "automation");
    for (let index = 0; index < 4; index += 1) {
      seedTurn(f.journal, {
        conversationId: "c1",
        turnId: `t${index}`,
        seq: index,
        startedAt: daysAgo(120 - index),
        reply: `answer ${index}`,
      });
    }
    seedTurn(f.journal, {
      conversationId: "c1",
      turnId: "t4",
      seq: 4,
      startedAt: daysAgo(2),
      reply: "answer 4",
    });
    seedTurn(f.journal, {
      conversationId: "c1",
      turnId: "t5",
      seq: 5,
      startedAt: daysAgo(1),
      reply: "answer 5",
    });
    const archival = runConversationArchival(
      { journal: f.journal, blobSink: f.sink, custodyProven: () => true },
      { nowMs: now }
    );
    expect(archival.turnsPruned).toBeGreaterThan(0);

    const newest = await store.getSessionRehydrated(APP, "c1", { limit: 2 });
    expect(newest?.messages).toHaveLength(4);
    expect(newest?.hasMore).toBe(true);
    expect(newest?.oldestSeq).toBe(4);

    const older = await store.getSessionRehydrated(APP, "c1", {
      limit: 2,
      beforeSeq: newest!.oldestSeq,
    });
    expect(older?.oldestSeq).toBe(2);
    expect(older?.hasMore).toBe(true);
    expect(
      older!.messages.some(
        (m) => (m.payload as { fromArchive?: boolean }).fromArchive
      )
    ).toBe(true);

    const oldest = await store.getSessionRehydrated(APP, "c1", {
      limit: 2,
      beforeSeq: older!.oldestSeq,
    });
    expect(oldest?.oldestSeq).toBe(0);
    expect(oldest?.hasMore).toBe(false);

    const whole = await store.getSessionRehydrated(APP, "c1");
    expect(whole?.messages).toHaveLength(12);
    expect(whole?.hasMore).toBe(false);
  });

  it("rehydrated read merges archived + live in seq order, byte-equal to pre-archive", async () => {
    const store = f.store();
    seedConversation(f.journal, "c1", "automation");
    seedTurn(f.journal, {
      conversationId: "c1",
      turnId: "t0",
      seq: 0,
      startedAt: daysAgo(120),
      reply: "answer zero",
      attachmentHash: "a".repeat(64),
    });
    seedTurn(f.journal, {
      conversationId: "c1",
      turnId: "t1",
      seq: 1,
      startedAt: daysAgo(110),
      reply: "answer one",
    });
    seedTurn(f.journal, {
      conversationId: "c1",
      turnId: "t2",
      seq: 2,
      startedAt: daysAgo(1),
      reply: "live head",
    });

    const before = store.getSession(APP, "c1");
    expect(before?.messages.length).toBe(6);
    const result = runConversationArchival(
      { journal: f.journal, blobSink: f.sink, custodyProven: () => true },
      { nowMs: now }
    );
    expect(result.turnsPruned).toBe(2); // t0 + t1 pruned; t2 (live head) stays
    const remaining = f.journal
      .prepare(`SELECT id FROM turns WHERE conversation_id = 'c1' ORDER BY seq`)
      .all() as { id: string }[];
    expect(remaining.map((r) => r.id)).toStrictEqual(["t2"]);

    const after = await store.getSessionRehydrated(APP, "c1");
    expect(after?.hasArchivedHistory).toBe(true);
    expect(after?.archivedTurnCount).toBe(2);
    expect(after?.archiveUnavailable).toBeUndefined();
    expect(after?.messages.length).toBe(before?.messages.length);
    expect(withoutMarker(after!.messages)).toStrictEqual(
      withoutMarker(before!.messages)
    );
    const archivedText = after!.messages
      .filter((m) => (m.payload as { fromArchive?: boolean }).fromArchive)
      .map((m) => (m.payload as { text?: string }).text);
    expect(archivedText).toContain("answer zero");
    expect(archivedText).toContain("answer one");
    const liveHead = after!.messages.find(
      (m) => (m.payload as { text?: string }).text === "live head"
    );
    expect(
      (liveHead!.payload as { fromArchive?: boolean }).fromArchive
    ).toBeUndefined();
    const userZero = after!.messages.find(
      (m) => (m.payload as { text?: string }).text === "ask 0"
    );
    expect(
      (userZero!.payload as { attachments?: unknown[] }).attachments
    ).toHaveLength(1);
  });

  it("read-only: feedback on a pruned archived turn no-ops; a live turn still updates", async () => {
    const store = f.store();
    seedConversation(f.journal, "c1", "automation");
    seedTurn(f.journal, {
      conversationId: "c1",
      turnId: "t0",
      seq: 0,
      startedAt: daysAgo(120),
      reply: "archived",
    });
    seedTurn(f.journal, {
      conversationId: "c1",
      turnId: "t1",
      seq: 1,
      startedAt: daysAgo(1),
      reply: "live",
    });
    runConversationArchival(
      { journal: f.journal, blobSink: f.sink, custodyProven: () => true },
      { nowMs: now }
    );

    expect(store.setTurnFeedback(APP, "c1", "t0", "up")).toBe(false);
    expect(store.setTurnFeedback(APP, "c1", "t1", "up")).toBe(true);
  });

  it("unavailable: a failing reader yields live rows + archiveUnavailable, no crash", async () => {
    const throwing: ArchiveBlobReader = async () => {
      throw new Error("remote unreachable");
    };
    const store = f.store(throwing);
    seedConversation(f.journal, "c1", "chat");
    seedTurn(f.journal, {
      conversationId: "c1",
      turnId: "t0",
      seq: 0,
      startedAt: daysAgo(120),
      reply: "archived",
    });
    runConversationArchival(
      { journal: f.journal, blobSink: f.sink, custodyProven: () => true },
      { nowMs: now }
    );

    const after = await store.getSessionRehydrated(APP, "c1");
    expect(after?.archiveUnavailable).toBe(true);
    expect(after?.hasArchivedHistory).toBe(true);
    expect(after?.messages).toStrictEqual([]);
  });

  it("unpruned archive row serves from live rows without fetching the blob", async () => {
    const store = f.store();
    seedConversation(f.journal, "c1", "chat");
    seedTurn(f.journal, {
      conversationId: "c1",
      turnId: "t0",
      seq: 0,
      startedAt: daysAgo(120),
      reply: "still live",
    });
    const result = runConversationArchival(
      { journal: f.journal, blobSink: f.sink, custodyProven: () => false },
      { nowMs: now }
    );
    expect(result.segmentsWritten).toBe(1);
    expect(result.segmentsPruned).toBe(0);

    const after = await store.getSessionRehydrated(APP, "c1");
    expect(after?.hasArchivedHistory).toBeUndefined(); // fast path — no pruned range
    expect(after?.archiveUnavailable).toBeUndefined();
    expect(after?.messages.length).toBe(2);
    expect(f.reads).toStrictEqual([]); // the blob reader was never called
  });

  it("GET session route surfaces the archive markers in the JSON body", async () => {
    const store = f.store();
    seedConversation(f.journal, "c1", "automation");
    seedTurn(f.journal, {
      conversationId: "c1",
      turnId: "t0",
      seq: 0,
      startedAt: daysAgo(120),
      reply: "archived",
    });
    seedTurn(f.journal, {
      conversationId: "c1",
      turnId: "t1",
      seq: 1,
      startedAt: daysAgo(1),
      reply: "live head",
    });
    runConversationArchival(
      { journal: f.journal, blobSink: f.sink, custodyProven: () => true },
      { nowMs: now }
    );

    const handler = makeConversationRouteHandler(() => store);
    const body = await getViaRoute(
      handler,
      `/_centraid-conversations/apps/${APP}/sessions/c1`
    );
    expect(body.hasArchivedHistory).toBe(true);
    expect(body.archivedTurnCount).toBe(1);
    const archived = (body.messages ?? []).filter(
      (m) => (m.payload as { fromArchive?: boolean }).fromArchive
    );
    expect(archived.length).toBeGreaterThan(0);
  });
});

interface RouteBody {
  hasArchivedHistory?: boolean;
  archivedTurnCount?: number;
  archiveUnavailable?: boolean;
  messages?: Array<{ payload: unknown; createdAt: number }>;
}

async function getViaRoute(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  url: string
): Promise<RouteBody> {
  const req = {
    method: "GET",
    url,
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {},
  } as unknown as IncomingMessage;
  let bodyText = "";
  const res = {
    statusCode: 200,
    writeHead(): unknown {
      return res;
    },
    setHeader(): void {},
    end(text?: string | Buffer): void {
      if (text) bodyText = Buffer.isBuffer(text) ? text.toString("utf8") : text;
    },
  } as unknown as ServerResponse;
  await handler(req, res);
  return JSON.parse(bodyText) as RouteBody;
}
