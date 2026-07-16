/*
 * Prepared-statement block + raw-row mappers for `ConversationStore`.
 *
 * Split out of `conversation-store.ts` to keep that file under the repo's
 * 500-line cap. The SQL targets the per-app runtime DB's conversation ledger
 * (`conversations`, `turns`, `items`, `attachments`, `automation_state` — see
 * `gateway-db.ts` RUNTIME_MIGRATIONS).
 *
 * Issue #190: the conversation is the spine. `turns.conversation_id` is a
 * NOT NULL same-file FK (CASCADE). Each automation FIRE is its own execution
 * conversation (`kind='automation'`, `automation_id=<ref>`, fresh id), so an
 * automation's run history is `conversations WHERE automation_id = ?` — each
 * row a single independent execution — and `automation_state` (keyed by
 * `automation_id`) is the only thing that persists across them.
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  Conversation,
  Turn,
  Item,
  Attachment,
  AutomationStateEntry,
  AutomationTriggerKind,
  AutomationTriggerOrigin,
  ItemKind,
  RunKind,
} from './schema.js';

export interface RawConversation {
  id: string;
  kind: string;
  user_id: string;
  app_id: string | null;
  automation_id: string | null;
  title: string;
  adapter_kind: string | null;
  adapter_session_id: string | null;
  turn_count: number;
  pinned: number;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface RawTurn {
  id: string;
  conversation_id: string;
  seq: number;
  parent_turn_id: string | null;
  trigger: string;
  trigger_origin: string | null;
  note: string | null;
  summary: string | null;
  output_json: string | null;
  retry_of: string | null;
  ok: number;
  error: string | null;
  feedback: string | null;
  pinned: number;
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

export interface RawItem {
  id: string;
  turn_id: string;
  ordinal: number;
  batch_id: number | null;
  kind: string;
  role: string | null;
  text: string | null;
  name: string | null;
  args_json: string | null;
  output_json: string | null;
  child_turn_id: string | null;
  model: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  app_id: string | null;
  ok: number;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
}

export interface RawAttachment {
  id: string;
  item_id: string;
  hash: string;
  mime: string;
  size_bytes: number;
  source: string | null;
  filename: string | null;
  created_at: number;
}

export interface RawState {
  automation_id: string;
  key: string;
  value_json: string;
  updated_at: number;
}

export function conversationFromRaw(raw: RawConversation): Conversation {
  return {
    id: raw.id,
    kind: raw.kind as RunKind,
    userId: raw.user_id,
    ...(raw.app_id !== null ? { appId: raw.app_id } : {}),
    ...(raw.automation_id !== null ? { automationId: raw.automation_id } : {}),
    title: raw.title,
    ...(raw.adapter_kind !== null ? { adapterKind: raw.adapter_kind } : {}),
    ...(raw.adapter_session_id !== null ? { adapterSessionId: raw.adapter_session_id } : {}),
    turnCount: Number(raw.turn_count),
    pinned: raw.pinned !== 0,
    archived: raw.archived !== 0,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function turnFromRaw(raw: RawTurn): Turn {
  return {
    turnId: raw.id,
    conversationId: raw.conversation_id,
    seq: raw.seq,
    ...(raw.parent_turn_id !== null ? { parentTurnId: raw.parent_turn_id } : {}),
    triggerKind: raw.trigger as AutomationTriggerKind,
    ...(raw.trigger_origin !== null
      ? { triggerOrigin: raw.trigger_origin as AutomationTriggerOrigin }
      : {}),
    ...(raw.note !== null ? { note: raw.note } : {}),
    ...(raw.retry_of !== null ? { retryOf: raw.retry_of } : {}),
    startedAt: raw.started_at,
    ...(raw.ended_at !== null ? { endedAt: raw.ended_at } : {}),
    ok: raw.ok !== 0,
    ...(raw.error !== null ? { error: raw.error } : {}),
    ...(raw.feedback === 'up' || raw.feedback === 'down' ? { feedback: raw.feedback } : {}),
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

export function itemFromRaw(raw: RawItem): Item {
  return {
    itemId: raw.id,
    turnId: raw.turn_id,
    ordinal: raw.ordinal,
    ...(raw.batch_id !== null ? { batchId: raw.batch_id } : {}),
    kind: raw.kind as ItemKind,
    ...(raw.role !== null ? { role: raw.role as 'user' | 'assistant' } : {}),
    ...(raw.text !== null ? { text: raw.text } : {}),
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
    ...(raw.child_turn_id !== null ? { childTurnId: raw.child_turn_id } : {}),
  };
}

export function attachmentFromRaw(raw: RawAttachment): Attachment {
  return {
    id: raw.id,
    itemId: raw.item_id,
    hash: raw.hash,
    mime: raw.mime,
    sizeBytes: raw.size_bytes,
    ...(raw.source !== null ? { source: raw.source } : {}),
    ...(raw.filename !== null ? { filename: raw.filename } : {}),
    createdAt: raw.created_at,
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

export interface PreparedStatements {
  insertConversation: StatementSync;
  updateAutomationConversation: StatementSync;
  getConversation: StatementSync;
  getConversationWithCount: StatementSync;
  listConversations: StatementSync;
  searchConversations: StatementSync;
  setConversationPinned: StatementSync;
  setConversationArchived: StatementSync;
  renameConversation: StatementSync;
  deleteConversationForUser: StatementSync;
  deleteConversationById: StatementSync;
  deleteConversationByAutomation: StatementSync;
  titleOf: StatementSync;
  setTitle: StatementSync;
  setKind: StatementSync;
  touchConversation: StatementSync;
  noteTurnWithAdapter: StatementSync;
  noteTurnKindOnly: StatementSync;
  noteTurnNoAdapter: StatementSync;
  maxSeq: StatementSync;
  insertTurn: StatementSync;
  finishTurn: StatementSync;
  getTurn: StatementSync;
  listTurnsAsc: StatementSync;
  listTurnsFiltered: StatementSync;
  listTurnsByAutomation: StatementSync;
  listInFlightAutomationTurns: StatementSync;
  setTurnPinned: StatementSync;
  setTurnFeedback: StatementSync;
  pruneAutomationByCount: StatementSync;
  pruneAutomationByDays: StatementSync;
  pruneAutomationErrorsOnly: StatementSync;
  insertItem: StatementSync;
  insertMessageIn: StatementSync;
  openItem: StatementSync;
  closeItem: StatementSync;
  listItems: StatementSync;
  messageInText: StatementSync;
  insertAttachment: StatementSync;
  listAttachmentsForItem: StatementSync;
  listAttachmentsForTurn: StatementSync;
  referencedHashes: StatementSync;
  upsertState: StatementSync;
  getState: StatementSync;
  deleteState: StatementSync;
  deleteStateByAutomation: StatementSync;
}

// Reconstructed transcript length = total items across the conversation's
// turns (one `message_in` per turn + each step/tool item).
const CONV_COLS = `c.id, c.kind, c.user_id, c.app_id, c.automation_id, c.title,
        c.adapter_kind, c.adapter_session_id, c.turn_count, c.pinned, c.archived,
        c.created_at, c.updated_at`;

// The reconstructed transcript-length subquery, shared by the list/search/get
// column blocks so a conversation's `msg_count` means the same thing everywhere.
const MSG_COUNT_SUBQUERY = `(SELECT COUNT(*) FROM items WHERE turn_id IN
          (SELECT id FROM turns WHERE conversation_id = c.id))`;

export function prepare(db: DatabaseSync): PreparedStatements {
  return {
    insertConversation: db.prepare(`
      INSERT INTO conversations
        (id, kind, user_id, app_id, automation_id, title,
         adapter_kind, adapter_session_id, turn_count, pinned, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?)
    `),
    updateAutomationConversation: db.prepare(`
      UPDATE conversations
      SET app_id = COALESCE(?, app_id), title = COALESCE(?, title), updated_at = ?
      WHERE id = ? AND kind = 'automation' AND automation_id = ?
    `),
    getConversation: db.prepare(`SELECT ${CONV_COLS} FROM conversations c WHERE c.id = ?`),
    getConversationWithCount: db.prepare(`
      SELECT ${CONV_COLS},
        ${MSG_COUNT_SUBQUERY} AS msg_count
      FROM conversations c WHERE c.id = ? AND c.user_id = ?
    `),
    // App scoping is a column filter (`?3 IS NULL OR c.app_id = ?`): the
    // ledger file is per VAULT, one shared `journal.db` (#280). Pinned threads
    // sort first (issue #420); archived rows still come back so the sidebar can
    // group them, they're just ordered last within their pin bucket.
    listConversations: db.prepare(`
      SELECT ${CONV_COLS},
        ${MSG_COUNT_SUBQUERY} AS msg_count
      FROM conversations c
      WHERE c.user_id = ? AND c.kind IN ('chat','build')
        AND (? IS NULL OR c.app_id = ?)
      ORDER BY c.archived ASC, c.pinned DESC, c.updated_at DESC
    `),
    // FTS5 search over titles + inbound message text (issue #420, Wave 3),
    // mirroring the vault's search: rank order + snippet() for match context.
    // Archived threads are out of the way, so they stay out of results.
    searchConversations: db.prepare(`
      SELECT ${CONV_COLS},
        ${MSG_COUNT_SUBQUERY} AS msg_count,
        snippet(fts_conversation, -1, '⟦', '⟧', '…', 12) AS snippet
      FROM fts_conversation
      JOIN conversations c ON c.id = fts_conversation.conversation_id
      WHERE fts_conversation MATCH ?
        AND c.user_id = ? AND c.kind IN ('chat','build')
        AND (? IS NULL OR c.app_id = ?)
        AND c.archived = 0
      ORDER BY fts_conversation.rank
      LIMIT ?
    `),
    setConversationPinned: db.prepare(
      `UPDATE conversations SET pinned = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    ),
    setConversationArchived: db.prepare(
      `UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    ),
    renameConversation: db.prepare(
      `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    ),
    deleteConversationForUser: db.prepare(`DELETE FROM conversations WHERE id = ? AND user_id = ?`),
    deleteConversationById: db.prepare(`DELETE FROM conversations WHERE id = ?`),
    deleteConversationByAutomation: db.prepare(`DELETE FROM conversations WHERE automation_id = ?`),
    titleOf: db.prepare(`SELECT title FROM conversations WHERE id = ? AND user_id = ?`),
    setTitle: db.prepare(
      `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    ),
    setKind: db.prepare(`UPDATE conversations SET kind = ? WHERE id = ? AND user_id = ?`),
    touchConversation: db.prepare(
      `UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?`,
    ),
    noteTurnWithAdapter: db.prepare(`
      UPDATE conversations
      SET turn_count = turn_count + 1, updated_at = ?, adapter_kind = ?, adapter_session_id = ?
      WHERE id = ? AND user_id = ?
    `),
    noteTurnKindOnly: db.prepare(`
      UPDATE conversations
      SET turn_count = turn_count + 1, updated_at = ?, adapter_kind = ?
      WHERE id = ? AND user_id = ?
    `),
    noteTurnNoAdapter: db.prepare(`
      UPDATE conversations
      SET turn_count = turn_count + 1, updated_at = ?
      WHERE id = ? AND user_id = ?
    `),
    maxSeq: db.prepare(`SELECT COALESCE(MAX(seq), -1) AS m FROM turns WHERE conversation_id = ?`),
    insertTurn: db.prepare(`
      INSERT INTO turns
        (id, conversation_id, seq, parent_turn_id, trigger, trigger_origin,
         retry_of, note, started_at, ok)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `),
    // Σ over this turn's own step/agent items; step/tool counts. SUM over an
    // empty set yields NULL — correct in-flight semantics.
    finishTurn: db.prepare(`
      UPDATE turns SET
        ended_at = $endedAt, ok = $ok, error = $error, summary = $summary,
        output_json = $outputJson,
        total_input_tokens = (
          SELECT SUM(input_tokens) FROM items
          WHERE turn_id = $tid AND kind IN ('step','agent')),
        total_output_tokens = (
          SELECT SUM(output_tokens) FROM items
          WHERE turn_id = $tid AND kind IN ('step','agent')),
        total_cache_read_tokens = (
          SELECT SUM(cache_read_tokens) FROM items
          WHERE turn_id = $tid AND kind IN ('step','agent')),
        total_cache_write_tokens = (
          SELECT SUM(cache_write_tokens) FROM items
          WHERE turn_id = $tid AND kind IN ('step','agent')),
        total_cost_usd = (
          SELECT SUM(cost_usd) FROM items
          WHERE turn_id = $tid AND kind IN ('step','agent')),
        step_count = (SELECT COUNT(*) FROM items WHERE turn_id = $tid AND kind = 'step'),
        tool_count = (SELECT COUNT(*) FROM items WHERE turn_id = $tid AND kind = 'tool')
      WHERE id = $tid
    `),
    getTurn: db.prepare(`SELECT * FROM turns WHERE id = ?`),
    // Ascending by seq — a transcript is replayed oldest-turn-first.
    listTurnsAsc: db.prepare(`
      SELECT * FROM turns WHERE conversation_id = ? ORDER BY seq ASC
    `),
    listTurnsFiltered: db.prepare(`
      SELECT * FROM turns
      WHERE conversation_id = ?
        AND (? IS NULL OR started_at >= ?)
        AND (? IS NULL OR ok = ?)
      ORDER BY started_at DESC LIMIT ?
    `),
    // An automation's history is the turns of its one stable conversation.
    listTurnsByAutomation: db.prepare(`
      SELECT t.* FROM turns t JOIN conversations c ON t.conversation_id = c.id
      WHERE c.automation_id = ?
        AND (? IS NULL OR t.started_at >= ?)
        AND (? IS NULL OR t.ok = ?)
      ORDER BY t.started_at DESC LIMIT ?
    `),
    listInFlightAutomationTurns: db.prepare(`
      SELECT t.* FROM turns t JOIN conversations c ON t.conversation_id = c.id
      WHERE c.kind = 'automation' AND t.ended_at IS NULL
      ORDER BY t.started_at DESC LIMIT ?
    `),
    setTurnPinned: db.prepare(`UPDATE turns SET pinned = ? WHERE id = ?`),
    // Message-level 👍/👎 (issue #420). `?1` is 'up' | 'down' | NULL (clear).
    setTurnFeedback: db.prepare(
      `UPDATE turns SET feedback = ? WHERE id = ? AND conversation_id = ?`,
    ),
    // Retention is per turn within the automation's stable conversation.
    // Deleting a turn cascades its items and attachments; pinned turns survive.
    pruneAutomationByCount: db.prepare(`
      DELETE FROM turns
      WHERE conversation_id IN (SELECT id FROM conversations WHERE automation_id = ?)
        AND id NOT IN (
          SELECT t.id FROM turns t JOIN conversations c ON t.conversation_id = c.id
          WHERE c.automation_id = ? ORDER BY t.started_at DESC LIMIT ?
        )
        AND pinned = 0
    `),
    pruneAutomationByDays: db.prepare(`
      DELETE FROM turns
      WHERE conversation_id IN (SELECT id FROM conversations WHERE automation_id = ?)
        AND started_at < ? AND pinned = 0
    `),
    // keep='errors': drop the successful fires, keep failures (+ pinned).
    pruneAutomationErrorsOnly: db.prepare(`
      DELETE FROM turns
      WHERE conversation_id IN (SELECT id FROM conversations WHERE automation_id = ?)
        AND ok = 1 AND pinned = 0
    `),
    insertItem: db.prepare(`
      INSERT INTO items (
        id, turn_id, ordinal, batch_id, kind, role, text, model, provider,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
        app_id, name, args_json, output_json, child_turn_id,
        ok, error, started_at, ended_at, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    // The inbound message (issue #190) — ordinal 0 of the turn. Attachments
    // hang off the returned item id.
    insertMessageIn: db.prepare(`
      INSERT INTO items (id, turn_id, ordinal, kind, role, text, ok, started_at)
      VALUES (?, ?, ?, 'message_in', ?, ?, 1, ?)
    `),
    // Ledger-tail hybrid (issue #158): durable "running" row, ended_at NULL.
    openItem: db.prepare(`
      INSERT INTO items (
        id, turn_id, ordinal, batch_id, kind, app_id, name, args_json, ok, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `),
    closeItem: db.prepare(`
      UPDATE items SET
        ok = $ok, output_json = $outputJson, error = $error,
        child_turn_id = $childTurnId,
        input_tokens = $inputTokens, output_tokens = $outputTokens,
        cache_read_tokens = $cacheReadTokens, cache_write_tokens = $cacheWriteTokens,
        model = $model, provider = $provider, cost_usd = $costUsd,
        ended_at = $endedAt, duration_ms = $durationMs
      WHERE id = $itemId
    `),
    listItems: db.prepare(`
      SELECT * FROM items WHERE turn_id = ? ORDER BY ordinal ASC, started_at ASC
    `),
    messageInText: db.prepare(
      `SELECT text FROM items WHERE turn_id = ? AND kind = 'message_in' ORDER BY ordinal ASC LIMIT 1`,
    ),
    insertAttachment: db.prepare(`
      INSERT INTO attachments
        (id, item_id, hash, mime, size_bytes, source, filename, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listAttachmentsForItem: db.prepare(
      `SELECT * FROM attachments WHERE item_id = ? ORDER BY created_at ASC`,
    ),
    listAttachmentsForTurn: db.prepare(`
      SELECT a.* FROM attachments a JOIN items i ON a.item_id = i.id
      WHERE i.turn_id = ? ORDER BY a.created_at ASC
    `),
    referencedHashes: db.prepare(`SELECT DISTINCT hash FROM attachments`),
    upsertState: db.prepare(`
      INSERT INTO automation_state (automation_id, key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(automation_id, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `),
    getState: db.prepare(`SELECT * FROM automation_state WHERE automation_id = ? AND key = ?`),
    deleteState: db.prepare(`DELETE FROM automation_state WHERE automation_id = ? AND key = ?`),
    deleteStateByAutomation: db.prepare(`DELETE FROM automation_state WHERE automation_id = ?`),
  };
}
