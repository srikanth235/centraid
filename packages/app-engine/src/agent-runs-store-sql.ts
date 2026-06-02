/*
 * Prepared-statement block + raw-row mappers for `AgentRunsStore`.
 *
 * Split out of `agent-runs-store.ts` to keep that file under the
 * repo's 500-line cap. The SQL targets the activity DB's unified ledger
 * tables (`runs`, `run_nodes`, `automation_state` — see `gateway-db.ts`
 * ACTIVITY_MIGRATIONS).
 *
 * Model-B (issue #90): a run is keyed to an automation by its UUID
 * `automation_id`. The ledger is a single global store — no app scope —
 * so `runs.automation_id` / `run_nodes.run_id` / `run_nodes.id` are all
 * globally-unique keys that need no second predicate.
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  AgentRunRow,
  AgentRunNodeRow,
  AutomationStateEntry,
  AutomationTriggerKind,
  AutomationTriggerOrigin,
  AgentRunNodeKind,
  RunKind,
} from './agent-runs-schema.js';

export interface RawRun {
  id: string;
  kind: string;
  automation_id: string | null;
  conversation_id: string | null;
  app_id: string | null;
  trigger: string;
  trigger_origin: string | null;
  parent_run_id: string | null;
  note: string | null;
  summary: string | null;
  input_json: string | null;
  output_json: string | null;
  ok: number;
  error: string | null;
  pinned: number;
  retry_of: string | null;
  started_at: number;
  ended_at: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cache_read_tokens: number | null;
  total_cache_write_tokens: number | null;
  total_cost_usd: number | null;
  step_count: number | null;
  tool_count: number | null;
}

export interface RawNode {
  id: string;
  run_id: string;
  ordinal: number;
  batch_id: number | null;
  kind: string;
  model: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  app_id: string | null;
  name: string | null;
  args_json: string | null;
  output_json: string | null;
  child_run_id: string | null;
  ok: number;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
}

export interface RawState {
  automation_id: string;
  key: string;
  value_json: string;
  updated_at: number;
}

export interface PreparedStatements {
  insertRun: StatementSync;
  finishRun: StatementSync;
  getRun: StatementSync;
  listRunsByAutomation: StatementSync;
  listRunsByConversation: StatementSync;
  listRunsAll: StatementSync;
  lastRunByAutomation: StatementSync;
  setPinned: StatementSync;
  pinnedRunByAutomation: StatementSync;
  listChildRunsByParent: StatementSync;
  insertNode: StatementSync;
  openNode: StatementSync;
  closeNode: StatementSync;
  listNodesByRun: StatementSync;
  upsertState: StatementSync;
  getState: StatementSync;
  deleteState: StatementSync;
  pruneByCount: StatementSync;
  pruneByDays: StatementSync;
  pruneErrorsOnly: StatementSync;
  countRunsByAutomation: StatementSync;
  deleteRunsByAutomation: StatementSync;
  deleteStateByAutomation: StatementSync;
  dominantModel: StatementSync;
}

export function runFromRaw(raw: RawRun): AgentRunRow {
  return {
    runId: raw.id,
    kind: raw.kind as RunKind,
    ...(raw.automation_id !== null ? { automationId: raw.automation_id } : {}),
    triggerKind: raw.trigger as AutomationTriggerKind,
    ...(raw.trigger_origin !== null
      ? { triggerOrigin: raw.trigger_origin as AutomationTriggerOrigin }
      : {}),
    ...(raw.parent_run_id !== null ? { parentRunId: raw.parent_run_id } : {}),
    ...(raw.conversation_id !== null ? { conversationId: raw.conversation_id } : {}),
    ...(raw.app_id !== null ? { appId: raw.app_id } : {}),
    ...(raw.note !== null ? { note: raw.note } : {}),
    ...(raw.retry_of !== null ? { retryOf: raw.retry_of } : {}),
    ...(raw.input_json !== null ? { inputJson: raw.input_json } : {}),
    startedAt: raw.started_at,
    ...(raw.ended_at !== null ? { endedAt: raw.ended_at } : {}),
    ok: raw.ok !== 0,
    ...(raw.error !== null ? { error: raw.error } : {}),
    ...(raw.summary !== null ? { summary: raw.summary } : {}),
    ...(raw.output_json !== null ? { outputJson: raw.output_json } : {}),
    pinned: raw.pinned !== 0,
    ...(raw.total_input_tokens !== null ? { totalInputTokens: raw.total_input_tokens } : {}),
    ...(raw.total_output_tokens !== null ? { totalOutputTokens: raw.total_output_tokens } : {}),
    ...(raw.total_cache_read_tokens !== null
      ? { totalCacheReadTokens: raw.total_cache_read_tokens }
      : {}),
    ...(raw.total_cache_write_tokens !== null
      ? { totalCacheWriteTokens: raw.total_cache_write_tokens }
      : {}),
    ...(raw.total_cost_usd !== null ? { totalCostUsd: raw.total_cost_usd } : {}),
    ...(raw.step_count !== null ? { stepCount: raw.step_count } : {}),
    ...(raw.tool_count !== null ? { toolCount: raw.tool_count } : {}),
  };
}

export function nodeFromRaw(raw: RawNode): AgentRunNodeRow {
  return {
    nodeId: raw.id,
    runId: raw.run_id,
    ordinal: raw.ordinal,
    ...(raw.batch_id !== null ? { batchId: raw.batch_id } : {}),
    kind: raw.kind as AgentRunNodeKind,
    ...(raw.name !== null ? { name: raw.name } : {}),
    ...(raw.args_json !== null ? { argsJson: raw.args_json } : {}),
    ...(raw.output_json !== null ? { outputJson: raw.output_json } : {}),
    ok: raw.ok !== 0,
    ...(raw.error !== null ? { error: raw.error } : {}),
    startedAt: raw.started_at,
    ...(raw.ended_at !== null ? { endedAt: raw.ended_at } : {}),
    ...(raw.duration_ms !== null ? { durationMs: raw.duration_ms } : {}),
    ...(raw.input_tokens !== null ? { inputTokens: raw.input_tokens } : {}),
    ...(raw.output_tokens !== null ? { outputTokens: raw.output_tokens } : {}),
    ...(raw.cache_read_tokens !== null ? { cacheReadTokens: raw.cache_read_tokens } : {}),
    ...(raw.cache_write_tokens !== null ? { cacheWriteTokens: raw.cache_write_tokens } : {}),
    ...(raw.model !== null ? { model: raw.model } : {}),
    ...(raw.provider !== null ? { provider: raw.provider } : {}),
    ...(raw.cost_usd !== null ? { costUsd: raw.cost_usd } : {}),
    ...(raw.app_id !== null ? { appId: raw.app_id } : {}),
    ...(raw.child_run_id !== null ? { childRunId: raw.child_run_id } : {}),
  };
}

export function stateFromRaw(raw: RawState): AutomationStateEntry {
  return {
    automationId: raw.automation_id,
    key: raw.key,
    valueJson: raw.value_json,
    updatedAt: raw.updated_at,
  };
}

export function prepare(db: DatabaseSync): PreparedStatements {
  return {
    insertRun: db.prepare(`
      INSERT INTO runs
        (id, kind, automation_id, conversation_id, app_id,
         trigger, trigger_origin, parent_run_id, retry_of, note,
         input_json, started_at, ok)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `),
    // The `total_*` rollup is Σ over this run's own step/agent nodes;
    // `step_count` / `tool_count` count the matching nodes. SUM over an
    // empty set yields NULL — correct in-flight semantics for a run with
    // no recorded inference calls.
    finishRun: db.prepare(`
      UPDATE runs SET
        ended_at = $endedAt, ok = $ok, error = $error,
        summary = $summary, output_json = $outputJson,
        total_input_tokens = (
          SELECT SUM(input_tokens) FROM run_nodes
          WHERE run_id = $rid AND kind IN ('step','agent')),
        total_output_tokens = (
          SELECT SUM(output_tokens) FROM run_nodes
          WHERE run_id = $rid AND kind IN ('step','agent')),
        total_cache_read_tokens = (
          SELECT SUM(cache_read_tokens) FROM run_nodes
          WHERE run_id = $rid AND kind IN ('step','agent')),
        total_cache_write_tokens = (
          SELECT SUM(cache_write_tokens) FROM run_nodes
          WHERE run_id = $rid AND kind IN ('step','agent')),
        total_cost_usd = (
          SELECT SUM(cost_usd) FROM run_nodes
          WHERE run_id = $rid AND kind IN ('step','agent')),
        step_count = (
          SELECT COUNT(*) FROM run_nodes WHERE run_id = $rid AND kind = 'step'),
        tool_count = (
          SELECT COUNT(*) FROM run_nodes WHERE run_id = $rid AND kind = 'tool')
      WHERE id = $rid
    `),
    getRun: db.prepare(`SELECT * FROM runs WHERE id = ?`),
    listRunsByAutomation: db.prepare(`
      SELECT * FROM runs
      WHERE automation_id = ?
        AND (? IS NULL OR started_at >= ?)
        AND (? IS NULL OR ok = ?)
      ORDER BY started_at DESC LIMIT ?
    `),
    // Ascending — the chat transcript is replayed oldest-turn-first.
    listRunsByConversation: db.prepare(`
      SELECT * FROM runs
      WHERE conversation_id = ?
      ORDER BY started_at ASC
    `),
    listRunsAll: db.prepare(`
      SELECT * FROM runs
      WHERE (? IS NULL OR started_at >= ?)
        AND (? IS NULL OR ok = ?)
      ORDER BY started_at DESC LIMIT ?
    `),
    lastRunByAutomation: db.prepare(`
      SELECT * FROM runs
      WHERE automation_id = ? AND (? IS NULL OR ok = ?)
      ORDER BY started_at DESC LIMIT 1
    `),
    setPinned: db.prepare(`UPDATE runs SET pinned = ? WHERE id = ?`),
    pinnedRunByAutomation: db.prepare(`
      SELECT * FROM runs
      WHERE automation_id = ? AND pinned = 1
      ORDER BY started_at DESC LIMIT 1
    `),
    listChildRunsByParent: db.prepare(`
      SELECT * FROM runs WHERE parent_run_id = ? ORDER BY started_at ASC
    `),
    insertNode: db.prepare(`
      INSERT INTO run_nodes (
        id, run_id, ordinal, batch_id, kind, model, provider,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
        app_id, name, args_json, output_json, child_run_id,
        ok, error, started_at, ended_at, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    // Ledger-tail hybrid (issue #158): a node lands in two writes. `openNode`
    // inserts the durable "running" row — `ended_at`/`duration_ms` stay NULL
    // (the in-flight marker the run viewer reads), `ok` provisionally 1.
    openNode: db.prepare(`
      INSERT INTO run_nodes (
        id, run_id, ordinal, batch_id, kind, app_id, name, args_json, ok, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `),
    // `closeNode` settles the row: outcome + the token/model rollup the
    // `ctx.agent` adapter learns only at end-of-turn (Phase 2). Every column
    // is set explicitly (open left them NULL), so callers pass null for the
    // fields that don't apply to the node kind.
    closeNode: db.prepare(`
      UPDATE run_nodes SET
        ok = $ok, output_json = $outputJson, error = $error,
        child_run_id = $childRunId,
        input_tokens = $inputTokens, output_tokens = $outputTokens,
        cache_read_tokens = $cacheReadTokens, cache_write_tokens = $cacheWriteTokens,
        model = $model, provider = $provider, cost_usd = $costUsd,
        ended_at = $endedAt, duration_ms = $durationMs
      WHERE id = $nodeId
    `),
    listNodesByRun: db.prepare(`
      SELECT * FROM run_nodes WHERE run_id = ? ORDER BY ordinal ASC, started_at ASC
    `),
    upsertState: db.prepare(`
      INSERT INTO automation_state (automation_id, key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(automation_id, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `),
    getState: db.prepare(`SELECT * FROM automation_state WHERE automation_id = ? AND key = ?`),
    deleteState: db.prepare(`DELETE FROM automation_state WHERE automation_id = ? AND key = ?`),
    pruneByCount: db.prepare(`
      DELETE FROM runs
      WHERE automation_id = ?
        AND pinned = 0
        AND id NOT IN (
          SELECT id FROM runs
          WHERE automation_id = ?
          ORDER BY started_at DESC LIMIT ?
        )
    `),
    pruneByDays: db.prepare(
      `DELETE FROM runs WHERE automation_id = ? AND pinned = 0 AND started_at < ?`,
    ),
    pruneErrorsOnly: db.prepare(
      `DELETE FROM runs WHERE automation_id = ? AND pinned = 0 AND ok = 1`,
    ),
    countRunsByAutomation: db.prepare(`SELECT COUNT(*) AS c FROM runs WHERE automation_id = ?`),
    deleteRunsByAutomation: db.prepare(`DELETE FROM runs WHERE automation_id = ?`),
    deleteStateByAutomation: db.prepare(`DELETE FROM automation_state WHERE automation_id = ?`),
    // The run's dominant model — the one that burned the most tokens
    // across its step/agent nodes. Feeds the central analytics summary.
    dominantModel: db.prepare(`
      SELECT model FROM run_nodes
      WHERE run_id = ? AND model IS NOT NULL AND kind IN ('step','agent')
      GROUP BY model
      ORDER BY SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) DESC
      LIMIT 1
    `),
  };
}
