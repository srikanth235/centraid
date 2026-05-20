/*
 * Prepared-statement block + raw-row mappers for `AutomationRunsStore`.
 *
 * Split out of `automation-runs-store.ts` to keep that file under the
 * repo's 500-line cap. The SQL targets the gateway DB's automation
 * run-audit tables (`automation_runs`, `automation_run_nodes`,
 * `automation_state` — see `gateway-db.ts` MIGRATIONS[2]).
 *
 * Name-scoped statements carry an `origin_app_id IS ?` predicate so
 * each `AutomationRunsStore` only sees its own bound app's rows; `IS`
 * (not `=`) is used so a NULL binding would still match — for v0 the
 * bound id is always a string, but `IS` is the correct null-safe form.
 * Run-id / node-id-scoped statements need no app predicate — UUIDs are
 * globally unique.
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  AutomationRunRow,
  AutomationRunNodeRow,
  AutomationStateEntry,
  AutomationTriggerKind,
  AutomationRunNodeKind,
} from './automation-runs-schema.js';

export interface RawRun {
  run_id: string;
  origin_app_id: string | null;
  automation_name: string;
  trigger_kind: string;
  parent_run_id: string | null;
  input_json: string | null;
  started_at: number;
  ended_at: number | null;
  ok: number;
  error: string | null;
  summary: string | null;
  output_json: string | null;
  pinned: number;
}

export interface RawNode {
  node_id: string;
  run_id: string;
  ordinal: number;
  batch_id: number | null;
  kind: string;
  name: string;
  args_json: string | null;
  output_json: string | null;
  ok: number;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  child_run_id: string | null;
}

export interface RawState {
  origin_app_id: string | null;
  automation_name: string;
  key: string;
  value_json: string;
  updated_at: number;
}

export interface PreparedStatements {
  insertRun: StatementSync;
  finishRun: StatementSync;
  getRun: StatementSync;
  listRunsByName: StatementSync;
  listRunsAll: StatementSync;
  lastRunByName: StatementSync;
  setPinned: StatementSync;
  pinnedRunByName: StatementSync;
  listChildRunsByParent: StatementSync;
  insertNode: StatementSync;
  listNodesByRun: StatementSync;
  upsertState: StatementSync;
  getState: StatementSync;
  deleteState: StatementSync;
  pruneByCount: StatementSync;
  pruneByDays: StatementSync;
  pruneErrorsOnly: StatementSync;
  countRunsByName: StatementSync;
  deleteRunsByApp: StatementSync;
  deleteStateByApp: StatementSync;
}

export function runFromRaw(raw: RawRun): AutomationRunRow {
  return {
    runId: raw.run_id,
    automationName: raw.automation_name,
    triggerKind: raw.trigger_kind as AutomationTriggerKind,
    ...(raw.parent_run_id !== null ? { parentRunId: raw.parent_run_id } : {}),
    ...(raw.input_json !== null ? { inputJson: raw.input_json } : {}),
    startedAt: raw.started_at,
    ...(raw.ended_at !== null ? { endedAt: raw.ended_at } : {}),
    ok: raw.ok !== 0,
    ...(raw.error !== null ? { error: raw.error } : {}),
    ...(raw.summary !== null ? { summary: raw.summary } : {}),
    ...(raw.output_json !== null ? { outputJson: raw.output_json } : {}),
    pinned: raw.pinned !== 0,
  };
}

export function nodeFromRaw(raw: RawNode): AutomationRunNodeRow {
  return {
    nodeId: raw.node_id,
    runId: raw.run_id,
    ordinal: raw.ordinal,
    ...(raw.batch_id !== null ? { batchId: raw.batch_id } : {}),
    kind: raw.kind as AutomationRunNodeKind,
    name: raw.name,
    ...(raw.args_json !== null ? { argsJson: raw.args_json } : {}),
    ...(raw.output_json !== null ? { outputJson: raw.output_json } : {}),
    ok: raw.ok !== 0,
    ...(raw.error !== null ? { error: raw.error } : {}),
    startedAt: raw.started_at,
    ...(raw.ended_at !== null ? { endedAt: raw.ended_at } : {}),
    ...(raw.duration_ms !== null ? { durationMs: raw.duration_ms } : {}),
    ...(raw.input_tokens !== null ? { inputTokens: raw.input_tokens } : {}),
    ...(raw.output_tokens !== null ? { outputTokens: raw.output_tokens } : {}),
    ...(raw.child_run_id !== null ? { childRunId: raw.child_run_id } : {}),
  };
}

export function stateFromRaw(raw: RawState): AutomationStateEntry {
  return {
    automationName: raw.automation_name,
    key: raw.key,
    valueJson: raw.value_json,
    updatedAt: raw.updated_at,
  };
}

export function prepare(db: DatabaseSync): PreparedStatements {
  return {
    insertRun: db.prepare(`
      INSERT INTO automation_runs
        (run_id, origin_app_id, automation_name, trigger_kind, parent_run_id, input_json, started_at, ok)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `),
    finishRun: db.prepare(`
      UPDATE automation_runs
      SET ended_at = ?, ok = ?, error = ?, summary = ?, output_json = ?
      WHERE run_id = ?
    `),
    getRun: db.prepare(`SELECT * FROM automation_runs WHERE run_id = ?`),
    listRunsByName: db.prepare(`
      SELECT * FROM automation_runs
      WHERE automation_name = ?
        AND origin_app_id IS ?
        AND (? IS NULL OR started_at >= ?)
        AND (? IS NULL OR ok = ?)
      ORDER BY started_at DESC LIMIT ?
    `),
    listRunsAll: db.prepare(`
      SELECT * FROM automation_runs
      WHERE origin_app_id IS ?
        AND (? IS NULL OR started_at >= ?)
        AND (? IS NULL OR ok = ?)
      ORDER BY started_at DESC LIMIT ?
    `),
    lastRunByName: db.prepare(`
      SELECT * FROM automation_runs
      WHERE automation_name = ? AND origin_app_id IS ? AND (? IS NULL OR ok = ?)
      ORDER BY started_at DESC LIMIT 1
    `),
    setPinned: db.prepare(`UPDATE automation_runs SET pinned = ? WHERE run_id = ?`),
    pinnedRunByName: db.prepare(`
      SELECT * FROM automation_runs
      WHERE automation_name = ? AND origin_app_id IS ? AND pinned = 1
      ORDER BY started_at DESC LIMIT 1
    `),
    listChildRunsByParent: db.prepare(`
      SELECT * FROM automation_runs WHERE parent_run_id = ? ORDER BY started_at ASC
    `),
    insertNode: db.prepare(`
      INSERT INTO automation_run_nodes (
        node_id, run_id, ordinal, batch_id, kind, name,
        args_json, output_json, ok, error,
        started_at, ended_at, duration_ms, input_tokens, output_tokens, child_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listNodesByRun: db.prepare(`
      SELECT * FROM automation_run_nodes WHERE run_id = ? ORDER BY ordinal ASC, started_at ASC
    `),
    upsertState: db.prepare(`
      INSERT INTO automation_state (origin_app_id, automation_name, key, value_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(origin_app_id, automation_name, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `),
    getState: db.prepare(
      `SELECT * FROM automation_state WHERE origin_app_id IS ? AND automation_name = ? AND key = ?`,
    ),
    deleteState: db.prepare(
      `DELETE FROM automation_state WHERE origin_app_id IS ? AND automation_name = ? AND key = ?`,
    ),
    pruneByCount: db.prepare(`
      DELETE FROM automation_runs
      WHERE automation_name = ?
        AND origin_app_id IS ?
        AND pinned = 0
        AND run_id NOT IN (
          SELECT run_id FROM automation_runs
          WHERE automation_name = ? AND origin_app_id IS ?
          ORDER BY started_at DESC LIMIT ?
        )
    `),
    pruneByDays: db.prepare(
      `DELETE FROM automation_runs WHERE automation_name = ? AND origin_app_id IS ? AND pinned = 0 AND started_at < ?`,
    ),
    pruneErrorsOnly: db.prepare(
      `DELETE FROM automation_runs WHERE automation_name = ? AND origin_app_id IS ? AND pinned = 0 AND ok = 1`,
    ),
    countRunsByName: db.prepare(
      `SELECT COUNT(*) AS c FROM automation_runs WHERE automation_name = ? AND origin_app_id IS ?`,
    ),
    deleteRunsByApp: db.prepare(`DELETE FROM automation_runs WHERE origin_app_id IS ?`),
    deleteStateByApp: db.prepare(`DELETE FROM automation_state WHERE origin_app_id IS ?`),
  };
}
