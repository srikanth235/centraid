import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";

import type { EligibleRange } from "./selector.js";
import { CONVERSATION_SEGMENT_VERSION } from "./types.js";
import type { ArchivedConversationSegment, BlobSink, Row } from "./types.js";

interface ModelRollup {
  model: string;
  runs: number;
  tokens: number;
  cost: number;
}

interface EffortRollup {
  effort: string;
  runs: number;
  tokens: number;
  cost: number;
}

interface DigestDelta {
  runCount: number;
  okCount: number;
  errCount: number;
  retryCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hydrationTokens: number;
  costUsd: number;
  stepCount: number;
  toolCount: number;
  firstStartedAt: number | null;
  lastEndedAt: number | null;
  models: Map<string, ModelRollup>;
  efforts: Map<string, EffortRollup>;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function dominantModelOf(journal: DatabaseSync, turnId: string): string | null {
  const row = journal
    .prepare(
      `SELECT i.model AS model FROM items i
        WHERE i.turn_id = ? AND i.model IS NOT NULL AND i.kind IN ('step','delegate')
        GROUP BY i.model
        ORDER BY SUM(COALESCE(i.input_tokens,0)+COALESCE(i.output_tokens,0)) DESC
        LIMIT 1`
    )
    .get(turnId) as { model: string } | undefined;
  return row?.model ?? null;
}

function dominantEffortOf(
  journal: DatabaseSync,
  turnId: string
): string | null {
  const row = journal
    .prepare(
      `SELECT i.effort AS effort FROM items i
        WHERE i.turn_id = ? AND i.effort IS NOT NULL AND i.kind IN ('step','delegate')
        GROUP BY i.effort
        ORDER BY SUM(COALESCE(i.input_tokens,0)+COALESCE(i.output_tokens,0)) DESC
        LIMIT 1`
    )
    .get(turnId) as { effort: string } | undefined;
  return row?.effort ?? null;
}

function computeDelta(
  journal: DatabaseSync,
  range: EligibleRange
): DigestDelta {
  const delta: DigestDelta = {
    runCount: 0,
    okCount: 0,
    errCount: 0,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    hydrationTokens: 0,
    costUsd: 0,
    stepCount: 0,
    toolCount: 0,
    firstStartedAt: null,
    lastEndedAt: null,
    models: new Map(),
    efforts: new Map(),
  };
  for (const t of range.turns) {
    delta.runCount += 1;
    if (num(t.ok) === 0) {
      delta.errCount += 1;
    } else {
      delta.okCount += 1;
    }
    if (t.retry_of !== null && t.retry_of !== undefined) delta.retryCount += 1;
    const input = num(t.total_input_tokens);
    const output = num(t.total_output_tokens);
    const cacheRead = num(t.total_cache_read_tokens);
    const cacheWrite = num(t.total_cache_write_tokens);
    delta.inputTokens += input;
    delta.outputTokens += output;
    delta.cacheReadTokens += cacheRead;
    delta.cacheWriteTokens += cacheWrite;
    delta.hydrationTokens += num(t.hydration_tokens);
    delta.costUsd += num(t.total_cost_usd);
    delta.stepCount += num(t.step_count);
    delta.toolCount += num(t.tool_count);
    const startedAt = num(t.started_at);
    const endedAt = t.ended_at as number | null;
    if (delta.firstStartedAt === null || startedAt < delta.firstStartedAt)
      delta.firstStartedAt = startedAt;
    if (
      endedAt !== null &&
      (delta.lastEndedAt === null || endedAt > delta.lastEndedAt)
    )
      delta.lastEndedAt = endedAt;
    const model = dominantModelOf(journal, t.id as string);
    if (model !== null) {
      const roll = delta.models.get(model) ?? {
        model,
        runs: 0,
        tokens: 0,
        cost: 0,
      };
      roll.runs += 1;
      roll.tokens += input + output + cacheRead + cacheWrite;
      roll.cost += num(t.total_cost_usd);
      delta.models.set(model, roll);
    }
    const effort = dominantEffortOf(journal, t.id as string);
    if (effort !== null) {
      const roll = delta.efforts.get(effort) ?? {
        effort,
        runs: 0,
        tokens: 0,
        cost: 0,
      };
      roll.runs += 1;
      roll.tokens += input + output + cacheRead + cacheWrite;
      roll.cost += num(t.total_cost_usd);
      delta.efforts.set(effort, roll);
    }
  }
  return delta;
}

function derivedAppId(conv: Row): string | null {
  const kind = conv.kind as string;
  const automationId = (conv.automation_id as string | null) ?? null;
  if (kind === "automation" && automationId && automationId.indexOf("/") > 0) {
    return automationId.slice(0, automationId.indexOf("/"));
  }
  return (conv.app_id as string | null) ?? null;
}

function mergeModels(
  existingJson: string,
  delta: Map<string, ModelRollup>
): string {
  const merged = new Map<string, ModelRollup>();
  try {
    for (const e of JSON.parse(existingJson) as ModelRollup[])
      merged.set(e.model, { ...e });
  } catch {
    // Intentionally empty.
  }
  for (const [model, roll] of delta) {
    const cur = merged.get(model) ?? { model, runs: 0, tokens: 0, cost: 0 };
    cur.runs += roll.runs;
    cur.tokens += roll.tokens;
    cur.cost += roll.cost;
    merged.set(model, cur);
  }
  return JSON.stringify([...merged.values()]);
}

function mergeEfforts(
  existingJson: string,
  delta: Map<string, EffortRollup>
): string {
  const merged = new Map<string, EffortRollup>();
  try {
    for (const e of JSON.parse(existingJson) as EffortRollup[])
      merged.set(e.effort, { ...e });
  } catch {
    // Intentionally empty.
  }
  for (const [effort, roll] of delta) {
    const cur = merged.get(effort) ?? { effort, runs: 0, tokens: 0, cost: 0 };
    cur.runs += roll.runs;
    cur.tokens += roll.tokens;
    cur.cost += roll.cost;
    merged.set(effort, cur);
  }
  return JSON.stringify([...merged.values()]);
}

function upsertDigest(
  journal: DatabaseSync,
  conv: Row,
  delta: DigestDelta,
  nowMs: number
): void {
  const conversationId = conv.id as string;
  const kind = conv.kind as string;
  const automationRef =
    kind === "automation"
      ? ((conv.automation_id as string | null) ?? null)
      : null;
  const appId = derivedAppId(conv);
  const title = (conv.title as string | null) ?? "";
  const automationName = kind === "automation" && title !== "" ? title : null;

  const existing = journal
    .prepare(`SELECT * FROM conversation_digest WHERE conversation_id = ?`)
    .get(conversationId) as Row | undefined;

  const prevModelsJson = (existing?.models_json as string | undefined) ?? "[]";
  const modelsJson = mergeModels(prevModelsJson, delta.models);
  const prevEffortsJson =
    (existing?.efforts_json as string | undefined) ?? "[]";
  const effortsJson = mergeEfforts(prevEffortsJson, delta.efforts);

  const firstStartedAt =
    existing && existing.first_started_at !== null
      ? Math.min(
          num(existing.first_started_at),
          delta.firstStartedAt ?? num(existing.first_started_at)
        )
      : delta.firstStartedAt;
  const lastEndedAt =
    existing && existing.last_ended_at !== null
      ? Math.max(
          num(existing.last_ended_at),
          delta.lastEndedAt ?? num(existing.last_ended_at)
        )
      : delta.lastEndedAt;

  journal
    .prepare(
      `INSERT INTO conversation_digest (
         conversation_id, kind, app_id, automation_ref, automation_name, title,
         first_started_at, last_ended_at, run_count, ok_count, err_count, retry_count,
         total_input_tokens, total_output_tokens, total_cache_read_tokens,
         total_cache_write_tokens, total_hydration_tokens, total_cost_usd, step_count, tool_count,
         models_json, efforts_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         kind = excluded.kind,
         app_id = excluded.app_id,
         automation_ref = excluded.automation_ref,
         automation_name = excluded.automation_name,
         title = excluded.title,
         first_started_at = ?,
         last_ended_at = ?,
         run_count = run_count + excluded.run_count,
         ok_count = ok_count + excluded.ok_count,
         err_count = err_count + excluded.err_count,
         retry_count = retry_count + excluded.retry_count,
         total_input_tokens = total_input_tokens + excluded.total_input_tokens,
         total_output_tokens = total_output_tokens + excluded.total_output_tokens,
         total_cache_read_tokens = total_cache_read_tokens + excluded.total_cache_read_tokens,
         total_cache_write_tokens = total_cache_write_tokens + excluded.total_cache_write_tokens,
         total_hydration_tokens = total_hydration_tokens + excluded.total_hydration_tokens,
         total_cost_usd = total_cost_usd + excluded.total_cost_usd,
         step_count = step_count + excluded.step_count,
         tool_count = tool_count + excluded.tool_count,
         models_json = ?,
         efforts_json = ?,
         updated_at = excluded.updated_at`
    )
    .run(
      conversationId,
      kind,
      appId,
      automationRef,
      automationName,
      title,
      firstStartedAt,
      lastEndedAt,
      delta.runCount,
      delta.okCount,
      delta.errCount,
      delta.retryCount,
      delta.inputTokens,
      delta.outputTokens,
      delta.cacheReadTokens,
      delta.cacheWriteTokens,
      delta.hydrationTokens,
      delta.costUsd,
      delta.stepCount,
      delta.toolCount,
      modelsJson,
      effortsJson,
      nowMs,
      firstStartedAt,
      lastEndedAt,
      modelsJson,
      effortsJson
    );
}

function distinctHashes(attachments: Row[]): string[] {
  const seen = new Set<string>();
  for (const a of attachments) {
    if (typeof a.workspace_path === "string" && a.workspace_path.length > 0)
      continue;
    const h = a.hash as string;
    if (!seen.has(h)) seen.add(h);
  }
  return [...seen];
}

export function archiveRange(
  journal: DatabaseSync,
  blobSink: BlobSink,
  conv: Row,
  range: EligibleRange,
  nowMs: number
): { segmentSha256: string; turnCount: number; itemCount: number } {
  const turnIds = range.turns.map((t) => t.id as string);
  const placeholders = turnIds.map(() => "?").join(", ");
  const items =
    turnIds.length > 0
      ? (journal
          .prepare(
            `SELECT * FROM items WHERE turn_id IN (${placeholders}) ORDER BY turn_id, ordinal`
          )
          .all(...turnIds) as Row[])
      : [];
  const itemIds = items.map((i) => i.id as string);
  const attachments =
    itemIds.length > 0
      ? (journal
          .prepare(
            `SELECT * FROM attachments WHERE item_id IN (${itemIds
              .map(() => "?")
              .join(", ")}) ORDER BY item_id, created_at`
          )
          .all(...itemIds) as Row[])
      : [];

  const segment: ArchivedConversationSegment = {
    version: CONVERSATION_SEGMENT_VERSION,
    conversationId: range.conversationId,
    conversation: conv,
    seqFrom: range.seqFrom,
    seqTo: range.seqTo,
    turns: range.turns,
    items,
    attachments,
  };
  const plaintext = Buffer.from(JSON.stringify(segment), "utf8");
  const bytes = gzipSync(plaintext);
  const { sha256, byteSize } = blobSink.ingestSync(bytes);
  if (!blobSink.has(sha256)) {
    throw new Error(
      `conversation archive segment ${sha256} did not land in the blob CAS`
    );
  }

  const hashes = distinctHashes(attachments);
  journal
    .prepare(
      `INSERT INTO conversation_archive (
         id, conversation_id, seq_from, seq_to, from_time, to_time, turn_count,
         item_count, segment_sha256, segment_bytes, plaintext_bytes,
         attachment_hashes_json, pruned_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    )
    .run(
      randomUUID(),
      range.conversationId,
      range.seqFrom,
      range.seqTo,
      num(range.turns[0]!.started_at),
      num(range.turns[range.turns.length - 1]!.ended_at),
      range.turns.length,
      items.length,
      sha256,
      byteSize,
      plaintext.length,
      JSON.stringify(hashes),
      nowMs
    );

  upsertDigest(journal, conv, computeDelta(journal, range), nowMs);
  return {
    segmentSha256: sha256,
    turnCount: range.turns.length,
    itemCount: items.length,
  };
}

export function readArchivedConversationSegment(
  bytes: Buffer
): ArchivedConversationSegment {
  return JSON.parse(
    gunzipSync(bytes).toString("utf8")
  ) as ArchivedConversationSegment;
}
