import { describe, expect, it } from 'vitest';
import type {
  OutboxGrant,
  OutboxItem,
  OutboxNeedsAuth,
  OutboxScopeRequest,
} from '../../../gateway-client-outbox.js';
import type { VaultParkedEntry } from '../../../gateway-client-vault.js';
import {
  buildGrantRow,
  buildNeedsAuthRow,
  buildOutboxRow,
  buildParkedRow,
  buildScopeRequestRow,
} from './approvalsData.js';

function outboxItem(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    itemId: 'item1',
    connection: { kind: 'pull.gmail', label: 'personal' },
    actor: 'gmail-send',
    actorKind: 'agent',
    verb: 'gmail.send',
    target: 'ravi@example.com',
    artifact: { to: 'ravi@example.com', subject: 'Hi', body: 'See you at 6.' },
    status: 'pending',
    grantId: null,
    stagedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    decidedAt: null,
    drainedAt: null,
    result: null,
    note: null,
    canEdit: false,
    ...overrides,
  };
}

describe('buildOutboxRow', () => {
  it('reads a plain-string recipient + subject/body straight off the artifact', () => {
    const row = buildOutboxRow(outboxItem());
    expect(row.recipient).toBe('ravi@example.com');
    expect(row.subject).toBe('Hi');
    expect(row.bodyPreview).toBe('See you at 6.');
    expect(row.connectionLabel).toBe('personal');
    expect(row.fields).toEqual(
      expect.arrayContaining([
        { key: 'to', label: 'To', value: 'ravi@example.com' },
        { key: 'subject', label: 'Subject', value: 'Hi' },
        { key: 'body', label: 'Body', value: 'See you at 6.' },
      ]),
    );
    expect(row.canEdit).toBe(false);
    expect(row.artifact).toEqual({ to: 'ravi@example.com', subject: 'Hi', body: 'See you at 6.' });
    expect(row.caller).toBe('gmail-send');
    expect(row.callerKind).toBe('agent');
  });

  it('falls back to the actor kind when the actor display name is null', () => {
    const row = buildOutboxRow(outboxItem({ actor: null, actorKind: 'app' }));
    expect(row.caller).toBe('app');
    expect(row.callerKind).toBe('app');
  });

  it('carries `canEdit` through from the wire item', () => {
    const row = buildOutboxRow(outboxItem({ canEdit: true }));
    expect(row.canEdit).toBe(true);
  });

  it('joins a list of recipients — the real gmail-send template stages `to` as an array', () => {
    const row = buildOutboxRow(
      outboxItem({ artifact: { to: ['a@x.com', 'b@x.com'], subject: 'Hi', body: 'Hey' } }),
    );
    expect(row.recipient).toBe('a@x.com, b@x.com');
  });

  it('falls back to the target when the artifact has no `to`', () => {
    const row = buildOutboxRow(outboxItem({ artifact: { payload: 'x' }, target: 'acct-9' }));
    expect(row.recipient).toBe('acct-9');
    expect(row.subject).toBeNull();
  });

  it('truncates a long body for the preview', () => {
    const long = 'x'.repeat(200);
    const row = buildOutboxRow(outboxItem({ artifact: { to: 'a@x.com', body: long } }));
    expect(row.bodyPreview?.endsWith('…')).toBe(true);
    expect(row.bodyPreview?.length).toBe(161);
  });
});

describe('buildNeedsAuthRow', () => {
  it('carries the connection health note through unchanged', () => {
    const row: OutboxNeedsAuth = {
      connectionId: 'c1',
      kind: 'pull.gmail',
      label: 'personal',
      note: 'token expired',
    };
    expect(buildNeedsAuthRow(row)).toEqual(row);
  });
});

describe('buildParkedRow', () => {
  it('falls back to the caller kind when the caller name is null', () => {
    const row: VaultParkedEntry = {
      invocationId: 'inv1',
      command: 'social.send_message',
      parkedAt: new Date().toISOString(),
      callerKind: 'app',
      callerId: 'app-1',
      caller: null,
      input: { to: 'x' },
    };
    const out = buildParkedRow(row);
    expect(out.caller).toBe('app');
    expect(out.callerKind).toBe('app');
    expect(out.inputPreview).toContain('"to"');
  });

  it('carries the assistant caller kind through for the Approvals badge', () => {
    const row: VaultParkedEntry = {
      invocationId: 'inv2',
      command: 'locker.purge_item',
      parkedAt: new Date().toISOString(),
      callerKind: 'assistant',
      callerId: 'agent-1',
      caller: 'Assistant',
      input: {},
    };
    const out = buildParkedRow(row);
    expect(out.caller).toBe('Assistant');
    expect(out.callerKind).toBe('assistant');
  });
});

describe('buildScopeRequestRow', () => {
  it('summarizes scopes as "schema.table (verbs)"', () => {
    const row: OutboxScopeRequest = {
      requestId: 'r1',
      plane: 'app',
      appId: 'invoicer',
      purpose: 'dpv:ServiceProvision',
      scopes: [
        { schema: 'core', verbs: 'read' },
        { schema: 'business', table: 'invoice', verbs: 'act' },
      ],
      requestedAt: new Date().toISOString(),
    };
    expect(buildScopeRequestRow(row).scopeSummary).toBe('core (read), business.invoice (act)');
  });
});

describe('buildGrantRow', () => {
  it('falls back to the actor id when the resolved name is null', () => {
    const row: OutboxGrant = {
      grantId: 'g1',
      actor: null,
      actorId: 'app-42',
      verb: 'gmail.send',
      target: 'ravi@example.com',
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    expect(buildGrantRow(row).actorLabel).toBe('app-42');
  });
});
