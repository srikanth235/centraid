import { describe, expect, it, vi } from 'vitest';

import type { BlockingSummary, OutboxGrant } from '../../../gateway-client-outbox.js';
import {
  confirmVaultParked,
  decideOutboxItem,
  getBlocking,
  listAgents,
  listAutomationTurns,
  listOutboxGrants,
  readAutomation,
  revokeOutboxGrant,
} from '../../../gateway-client.js';
import {
  decideConsentItem,
  filterConsentForAutomation,
  loadAutomationThreadData,
} from './automationThreadData.js';

// `automationThreadData.ts` imports the gateway-client barrel; stub it so
// pulling the module in doesn't run gateway-client-core's load-time
// `window.CentraidApi` side effect (same guard automationsData.test.ts uses).
// `vi.mock` is hoisted above these imports by vitest.
vi.mock(import('../../../gateway-client.js'), () => ({
  confirmVaultParked: vi.fn<typeof confirmVaultParked>(),
  decideOutboxItem: vi.fn<typeof decideOutboxItem>(),
  getBlocking: vi.fn<typeof getBlocking>(),
  listAgents: vi.fn<typeof listAgents>(),
  listAutomationTurns: vi.fn<typeof listAutomationTurns>(),
  listOutboxGrants: vi.fn<typeof listOutboxGrants>(),
  readAutomation: vi.fn<typeof readAutomation>(),
  revokeOutboxGrant: vi.fn<typeof revokeOutboxGrant>(),
}));

const row = (over: Partial<CentraidAutomationRow> = {}): CentraidAutomationRow =>
  ({
    id: 'digest',
    ref: 'digest/main',
    name: 'Daily Digest',
    enabled: true,
    triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
    manifest: { requires: { mcps: [] }, history: { keep: 'forever' } },
    ...over,
  }) as unknown as CentraidAutomationRow;

const blocking = (over: Partial<BlockingSummary> = {}): BlockingSummary => ({
  needsAuth: [],
  outbox: [],
  parked: [],
  scopeRequests: [],
  ...over,
});

describe(filterConsentForAutomation, () => {
  it('keeps only agent-kind parked/outbox rows whose caller/actor matches the automation name', () => {
    const data = blocking({
      outbox: [
        {
          actor: 'Daily Digest',
          actorId: 'agent-1',
          actorKind: 'agent',
          artifact: { to: 'a@b.com' },
          canEdit: false,
          connection: { kind: 'gmail', label: 'Work Gmail' },
          itemId: 'ob1',
          note: null,
          status: 'pending',
          stagedAt: '2026-07-01T00:00:00Z',
          target: 'a@b.com',
          verb: 'send',
        },
        {
          // Same display name, but the vault ASSISTANT — must not leak in.
          actor: 'Daily Digest',
          actorId: 'assistant-1',
          actorKind: 'assistant',
          artifact: {},
          canEdit: false,
          connection: { kind: 'gmail', label: 'Work Gmail' },
          itemId: 'ob2',
          note: null,
          status: 'pending',
          stagedAt: '2026-07-01T00:00:00Z',
          target: 'x@y.com',
          verb: 'send',
        },
        {
          // A different automation entirely — name doesn't match.
          actor: 'Weekly Report',
          actorId: 'agent-2',
          actorKind: 'agent',
          artifact: {},
          canEdit: false,
          connection: { kind: 'slack', label: 'Team Slack' },
          itemId: 'ob3',
          note: null,
          status: 'pending',
          stagedAt: '2026-07-01T00:00:00Z',
          target: '#general',
          verb: 'post',
        },
      ] as unknown as BlockingSummary['outbox'],
      parked: [
        {
          caller: 'Daily Digest',
          callerId: 'agent-1',
          callerKind: 'agent',
          command: 'notes.delete',
          input: { id: 'n1' },
          invocationId: 'p1',
          parkedAt: '2026-07-01T00:00:00Z',
        },
        {
          caller: 'Weekly Report',
          callerId: 'agent-2',
          callerKind: 'agent',
          command: 'notes.delete',
          input: {},
          invocationId: 'p2',
          parkedAt: '2026-07-01T00:00:00Z',
        },
      ],
    });
    const grants: OutboxGrant[] = [
      {
        actor: 'Daily Digest',
        actorId: 'agent-1',
        createdAt: '2026-06-01T00:00:00Z',
        grantId: 'g1',
        revokedAt: null,
        target: 'a@b.com',
        verb: 'send',
      },
      {
        actor: 'Weekly Report',
        actorId: 'agent-2',
        createdAt: '2026-06-01T00:00:00Z',
        grantId: 'g2',
        revokedAt: null,
        target: '#general',
        verb: 'post',
      },
    ];

    const consent = filterConsentForAutomation('agent-1', data, grants);

    expect(consent.outbox.map((o) => o.itemId)).toStrictEqual(['ob1']);
    expect(consent.parked.map((p) => p.invocationId)).toStrictEqual(['p1']);
    expect(consent.grants.map((g) => g.grantId)).toStrictEqual(['g1']);
  });

  it('returns empty lists when nothing matches the automation', () => {
    const consent = filterConsentForAutomation(undefined, blocking(), []);
    expect(consent).toStrictEqual({ grants: [], outbox: [], parked: [] });
  });
});

describe(loadAutomationThreadData, () => {
  it('returns null when the automation does not resolve', async () => {
    vi.mocked(readAutomation).mockResolvedValue(null);
    vi.mocked(listAutomationTurns).mockResolvedValue([]);
    vi.mocked(getBlocking).mockResolvedValue(blocking());
    vi.mocked(listOutboxGrants).mockResolvedValue([]);
    vi.mocked(listAgents).mockResolvedValue([]);

    const result = await loadAutomationThreadData({
      automationId: 'digest/main',
      gatewayOrigin: 'http://127.0.0.1:5173',
    });
    expect(result).toBeNull();
  });

  it('derives the header + sorts runs newest-first + tags date groups', async () => {
    vi.mocked(readAutomation).mockResolvedValue(row());
    const now = Date.now();
    vi.mocked(listAutomationTurns).mockResolvedValue([
      {
        automationId: 'digest/main',
        endedAt: now - 1000,
        ok: true,
        pinned: false,
        turnId: 'r-older',
        startedAt: now - 5000,
        summary: 'ok',
        triggerKind: 'scheduled',
      },
      {
        automationId: 'digest/main',
        endedAt: now,
        ok: false,
        error: 'boom',
        pinned: false,
        turnId: 'r-newer',
        startedAt: now - 500,
        triggerKind: 'scheduled',
      },
    ] as unknown as CentraidAutomationTurnRecord[]);
    vi.mocked(getBlocking).mockResolvedValue(blocking());
    vi.mocked(listOutboxGrants).mockResolvedValue([]);
    vi.mocked(listAgents).mockResolvedValue([
      {
        agentId: 'agent-1',
        hostKey: 'digest',
        partyId: 'party-1',
        name: 'Daily Digest',
        modelRef: 'centraid-automation',
        enrolledAt: '2026-01-01T00:00:00Z',
        grants: [],
      },
    ]);

    const result = await loadAutomationThreadData({
      automationId: 'digest/main',
      gatewayOrigin: 'http://127.0.0.1:5173',
    });

    expect(result?.row.ref).toBe('digest/main');
    expect(result?.data.header.name).toBe('Daily Digest');
    expect(result?.data.header.kindEyebrow).toBe('Cron schedule');
    expect(result?.data.runs.map((r) => r.runId)).toStrictEqual(['r-newer', 'r-older']);
    expect(result?.data.runs[0]?.status).toBe('fail');
    expect(result?.data.runs[0]?.summary).toBe('boom');
    expect(result?.data.runs[0]?.dateGroup).toBe('Today');
    expect(result?.data.runs[1]?.status).toBe('ok');
    expect(result?.data.runs.every((r) => r.entryKind === 'run')).toBe(true);
  });

  // The load-bearing half of the run-screen / compile-screen split: a compile
  // turn is the COMPILER working and must never appear in the run history. It
  // is distilled into an inert `plan` status instead.
  it('keeps compile turns out of the run history and reports them as plan status', async () => {
    vi.mocked(readAutomation).mockResolvedValue(row());
    const now = Date.now();
    vi.mocked(listAutomationTurns).mockResolvedValue([
      {
        automationId: 'digest/main',
        endedAt: now - 9000,
        ok: true,
        pinned: false,
        turnId: 'r-exec',
        startedAt: now - 10_000,
        summary: 'ok',
        triggerKind: 'scheduled',
      },
      {
        automationId: 'digest/main',
        endedAt: now - 1000,
        ok: false,
        error: 'handler.js failed to parse',
        pinned: false,
        turnId: 'c-1',
        startedAt: now - 2000,
        triggerKind: 'compile',
      },
      {
        automationId: 'digest/main',
        endedAt: now,
        ok: true,
        pinned: false,
        turnId: 'ask-1',
        startedAt: now - 100,
        summary: 'It failed because…',
        triggerKind: 'interactive',
      },
    ] as unknown as CentraidAutomationTurnRecord[]);
    vi.mocked(getBlocking).mockResolvedValue(blocking());
    vi.mocked(listOutboxGrants).mockResolvedValue([]);
    vi.mocked(listAgents).mockResolvedValue([]);

    const result = await loadAutomationThreadData({
      automationId: 'digest/main',
      gatewayOrigin: 'http://127.0.0.1:5173',
    });

    expect(result?.data.runs.map((r) => r.runId)).toStrictEqual(['ask-1', 'r-exec']);
    // An interactive turn is the owner asking, not the automation firing.
    expect(result?.data.runs.find((r) => r.runId === 'ask-1')?.entryKind).toBe('ask');
    expect(result?.data.runs.find((r) => r.runId === 'r-exec')?.entryKind).toBe('run');
    expect(result?.data.plan).toStrictEqual({
      detail: 'handler.js failed to parse',
      label: 'Compile failed',
      state: 'failed',
    });
    // The header reports the AUTOMATION, not its last compile.
    expect(result?.data.header.statusLabel).not.toBe('Compile failed');
  });

  it('calls a never-compiled automation out rather than showing an empty history', async () => {
    vi.mocked(readAutomation).mockResolvedValue(row({ enabled: false }));
    vi.mocked(listAutomationTurns).mockResolvedValue([]);
    vi.mocked(getBlocking).mockResolvedValue(blocking());
    vi.mocked(listOutboxGrants).mockResolvedValue([]);
    vi.mocked(listAgents).mockResolvedValue([]);

    const result = await loadAutomationThreadData({
      automationId: 'digest/main',
      gatewayOrigin: 'http://127.0.0.1:5173',
    });
    expect(result?.data.plan.state).toBe('never');
    expect(result?.data.runs).toStrictEqual([]);
  });
});

describe(decideConsentItem, () => {
  it('approves an outbox item and reports success only when executed', async () => {
    vi.mocked(decideOutboxItem).mockResolvedValue({
      invocationId: 'i1',
      output: {},
      receiptId: 'r1',
      status: 'executed',
    });
    const ok = await decideConsentItem({
      decision: 'approve',
      id: 'ob1',
      kind: 'outbox',
    });
    expect(ok).toBe(true);
    expect(decideOutboxItem).toHaveBeenCalledWith({
      decision: 'approve',
      itemId: 'ob1',
    });
  });

  it('reports failure when an outbox decision parks instead of executing', async () => {
    vi.mocked(decideOutboxItem).mockResolvedValue({
      invocationId: 'i1',
      reason: 'needs a fresh grant',
      status: 'parked',
    });
    const ok = await decideConsentItem({
      decision: 'approve',
      id: 'ob1',
      kind: 'outbox',
    });
    expect(ok).toBe(false);
  });

  it('confirms a parked invocation', async () => {
    vi.mocked(confirmVaultParked).mockResolvedValue({ status: 'confirmed' });
    const ok = await decideConsentItem({
      decision: 'approve',
      id: 'p1',
      kind: 'parked',
    });
    expect(ok).toBe(true);
    expect(confirmVaultParked).toHaveBeenCalledWith({
      approve: true,
      invocationId: 'p1',
    });
  });

  it('revokes a standing grant', async () => {
    vi.mocked(revokeOutboxGrant).mockResolvedValue({
      invocationId: 'i1',
      output: {},
      receiptId: 'r1',
      status: 'executed',
    });
    const ok = await decideConsentItem({
      decision: 'revoke',
      id: 'g1',
      kind: 'grant',
    });
    expect(ok).toBe(true);
    expect(revokeOutboxGrant).toHaveBeenCalledWith('g1');
  });
});
