/**
 * Direct unit tests for the conversation-ledger SQL layer (issue #545 B4).
 * Pins row mappers and the prepared-statement block independently of
 * ConversationStore orchestration.
 */

import { tempDirSync } from '@centraid/test-kit/temp-dir';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openJournalDb } from '../stores/gateway-db.js';
import {
  attachmentFromRaw,
  conversationFromRaw,
  itemFromRaw,
  prepare,
  stateFromRaw,
  turnFromRaw,
  type RawAttachment,
  type RawConversation,
  type RawItem,
  type RawState,
  type RawTurn,
} from './store-sql.js';

function rawConversation(over: Partial<RawConversation> = {}): RawConversation {
  return {
    id: 'c1',
    kind: 'chat',
    user_id: 'u1',
    app_id: 'app',
    automation_id: null,
    title: 'Hello',
    adapter_kind: null,
    adapter_session_id: null,
    adapter_usage_json: null,
    turn_count: 2,
    pinned: 0,
    archived: 0,
    created_at: 10,
    updated_at: 20,
    ...over,
  };
}

function rawTurn(over: Partial<RawTurn> = {}): RawTurn {
  return {
    id: 't1',
    conversation_id: 'c1',
    seq: 0,
    parent_turn_id: null,
    trigger: 'interactive',
    trigger_origin: null,
    note: null,
    summary: null,
    output_json: null,
    retry_of: null,
    idempotency_key: null,
    ok: 1,
    error: null,
    feedback: null,
    pinned: 0,
    started_at: 100,
    ended_at: 200,
    total_input_tokens: 10,
    total_output_tokens: 20,
    total_cache_read_tokens: null,
    total_cache_write_tokens: null,
    total_cost_usd: 0.01,
    step_count: 1,
    tool_count: 0,
    ...over,
  };
}

function rawItem(over: Partial<RawItem> = {}): RawItem {
  return {
    id: 'i1',
    turn_id: 't1',
    ordinal: 0,
    call_id: null,
    batch_id: null,
    kind: 'message_in',
    role: 'user',
    text: 'hi',
    name: null,
    args_json: null,
    output_json: null,
    raw_json: null,
    child_turn_id: null,
    model: null,
    provider: null,
    effort: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
    cost_source: null,
    app_id: null,
    ok: 1,
    error: null,
    started_at: 100,
    ended_at: null,
    duration_ms: null,
    ...over,
  };
}

describe('store-sql row mappers', () => {
  it('conversationFromRaw maps snake_case + flags and omits null optionals', () => {
    const full = conversationFromRaw(
      rawConversation({
        automation_id: 'app/digest',
        adapter_kind: 'acp',
        adapter_session_id: 'sess',
        pinned: 1,
        archived: 1,
      }),
    );
    expect(full).toStrictEqual({
      id: 'c1',
      kind: 'chat',
      userId: 'u1',
      appId: 'app',
      automationId: 'app/digest',
      title: 'Hello',
      adapterKind: 'acp',
      adapterSessionId: 'sess',
      hydrationCount: 0,
      turnCount: 2,
      pinned: true,
      archived: true,
      createdAt: 10,
      updatedAt: 20,
    });

    const sparse = conversationFromRaw(rawConversation({ app_id: null }));
    expect(sparse.appId).toBeUndefined();
    expect(sparse.automationId).toBeUndefined();
    expect(sparse.pinned).toBe(false);
  });

  it('turnFromRaw maps feedback only when up/down and preserves token rollups', () => {
    const t = turnFromRaw(
      rawTurn({
        feedback: 'up',
        trigger_origin: 'webhook',
        retry_of: 't0',
        error: 'boom',
      }),
    );
    expect(t.turnId).toBe('t1');
    expect(t.feedback).toBe('up');
    expect(t.triggerOrigin).toBe('webhook');
    expect(t.retryOf).toBe('t0');
    expect(t.error).toBe('boom');
    expect(t.ok).toBe(true);
    expect(t.totalInputTokens).toBe(10);
    expect(t.totalCostUsd).toBe(0.01);

    expect(turnFromRaw(rawTurn({ feedback: 'sideways', ok: 0 })).feedback).toBeUndefined();
    expect(turnFromRaw(rawTurn({ ok: 0 })).ok).toBe(false);
  });

  it('itemFromRaw maps step usage + costSource agent|estimated only', () => {
    const step = itemFromRaw(
      rawItem({
        kind: 'step',
        role: null,
        text: null,
        name: 'agent',
        model: 'gpt',
        provider: 'openai',
        effort: 'high',
        input_tokens: 5,
        output_tokens: 7,
        cost_usd: 0.02,
        cost_source: 'agent',
        child_turn_id: 'child',
      }),
    );
    expect(step.kind).toBe('step');
    expect(step.model).toBe('gpt');
    expect(step.effort).toBe('high');
    expect(step.inputTokens).toBe(5);
    expect(step.costSource).toBe('agent');
    expect(step.childTurnId).toBe('child');
    expect(itemFromRaw(rawItem({ cost_source: 'other' })).costSource).toBeUndefined();
  });

  it('attachmentFromRaw and stateFromRaw round-trip wire fields', () => {
    const att: RawAttachment = {
      id: 'a1',
      item_id: 'i1',
      hash: 'ab'.repeat(32),
      mime: 'image/png',
      size_bytes: 99,
      source: 'upload',
      filename: 'x.png',
      workspace_path: null,
      created_at: 1,
    };
    expect(attachmentFromRaw(att)).toStrictEqual({
      id: 'a1',
      itemId: 'i1',
      hash: 'ab'.repeat(32),
      mime: 'image/png',
      sizeBytes: 99,
      source: 'upload',
      filename: 'x.png',
      createdAt: 1,
    });

    const st: RawState = {
      automation_id: 'app/digest',
      key: 'cursor',
      value_json: '{"n":1}',
      updated_at: 5,
    };
    expect(stateFromRaw(st)).toStrictEqual({
      automationId: 'app/digest',
      key: 'cursor',
      valueJson: '{"n":1}',
      updatedAt: 5,
    });
  });
});

describe('store-sql prepare()', () => {
  it('prepares statements that insert and read a conversation on a real journal', () => {
    const dir = tempDirSync('centraid-store-sql-');
    const db = openJournalDb(path.join(dir, 'journal.db'));
    const stmts = prepare(db);

    // Every statement slot is a live prepared handle.
    expect(stmts.insertConversation.run).toBeTypeOf('function');
    expect(stmts.getConversation.get).toBeTypeOf('function');
    expect(stmts.insertTurn.run).toBeTypeOf('function');
    expect(stmts.insertItem.run).toBeTypeOf('function');
    expect(stmts.upsertState.run).toBeTypeOf('function');

    // (id, kind, user_id, app_id, automation_id, title, adapter_kind,
    //  created_at, updated_at) — adapter_session_id / adapter_usage_json /
    //  turn_count / pinned are fixed in SQL.
    stmts.insertConversation.run('c-sql', 'chat', 'u1', 'app', null, 'T', null, 1, 1);
    const row = stmts.getConversation.get('c-sql') as RawConversation | undefined;
    expect(row?.id).toBe('c-sql');
    expect(row?.title).toBe('T');
    expect(conversationFromRaw(row!).title).toBe('T');

    // (id, conversation_id, seq, parent_turn_id, trigger, trigger_origin,
    //  retry_of, idempotency_key, note, hydration_tokens, started_at) — ok is
    //  fixed to 0 in SQL.
    stmts.insertTurn.run(
      't-sql',
      'c-sql',
      0,
      null,
      'interactive',
      null,
      null,
      null,
      null,
      null,
      100,
    );
    const turn = stmts.getTurn.get('t-sql') as RawTurn | undefined;
    expect(turn?.conversation_id).toBe('c-sql');
    expect(turnFromRaw(turn!).triggerKind).toBe('interactive');

    db.close();
  });
});
