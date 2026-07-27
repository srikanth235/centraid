import { describe, expect, it } from 'vitest';
import { compileHydrationPlan, hydrationMessagesFromLedger } from './hydration.js';

describe('compileHydrationPlan', () => {
  it('keeps prose, summarizes tool calls, and drops tool outputs', () => {
    const plan = compileHydrationPlan(
      [
        { payload: { kind: 'user', text: 'Find the note', attachments: [{ filename: 'a.png' }] } },
        {
          payload: {
            kind: 'tool',
            tool: 'vault_sql',
            sql: 'SELECT  *\\nFROM notes',
            ok: true,
            result: { secret: 'must not cross' },
          },
        },
        { payload: { kind: 'ai', text: 'The note is here.' } },
      ],
      { includeAttachmentReferences: true },
    );
    expect(plan.prompt).toContain('User: Find the note');
    expect(plan.prompt).toContain('Tool call: vault_sql — SELECT *\\nFROM notes → ok');
    expect(plan.prompt).toContain('Assistant: The note is here.');
    expect(plan.prompt).toContain('Attachments: a.png');
    expect(plan.prompt).not.toContain('must not cross');
  });

  it('preserves terminal tool status without carrying tool output', () => {
    const plan = compileHydrationPlan([
      { payload: { kind: 'user', text: 'Try it' } },
      {
        payload: {
          kind: 'tool',
          tool: 'vault_sql',
          sql: 'SELECT 1',
          ok: false,
          result: 'private output',
        },
      },
      { payload: { kind: 'ai', text: 'It failed.' } },
    ]);
    expect(plan.prompt).toContain('Tool call: vault_sql — SELECT 1 → failed');
    expect(plan.prompt).not.toContain('private output');
  });

  it('honours the minimum-turn floor while enforcing the hard token budget', () => {
    const messages = Array.from({ length: 5 }, (_, index) => [
      { payload: { kind: 'user', text: `u${index} ${'x'.repeat(800)}` } },
      { payload: { kind: 'ai', text: `a${index} ${'y'.repeat(800)}` } },
    ]).flat();
    const plan = compileHydrationPlan(messages, { tokenBudget: 256, minTurns: 2 });
    expect(plan.includedTurns).toBe(2);
    expect(plan.omittedTurns).toBe(3);
    expect(plan.prompt).toContain('u4');
    expect(plan.prompt).not.toContain('u2');
    expect(plan.prompt).toContain('[turn truncated to hydration budget]');
    expect(plan.prompt).toContain('[End session handoff]');
    expect(plan.estimatedTokens).toBeLessThanOrEqual(256);
  });

  it('cites workspace and CAS artifact locations without embedding their output', () => {
    const plan = compileHydrationPlan([
      { payload: { kind: 'user', text: 'build it' } },
      {
        payload: {
          kind: 'tool',
          tool: 'write',
          artifacts: [
            { workspacePath: '/workspace/report.md', hash: 'a'.repeat(64) },
            { filename: 'terminal-output.txt', hash: 'b'.repeat(64) },
          ],
          result: 'large tool output must not cross',
        },
      },
      { payload: { kind: 'ai', text: 'Done.' } },
    ]);
    expect(plan.prompt).toContain('/workspace/report.md (sha256 aaaaaaaaaaaa…)');
    expect(plan.prompt).toContain('terminal-output.txt (sha256 bbbbbbbbbbbb…)');
    expect(plan.prompt).not.toContain('large tool output must not cross');
  });

  it('projects only completed turns past a runner watermark', () => {
    const turns = [
      {
        turnId: 'old',
        conversationId: 'c',
        seq: 0,
        triggerKind: 'interactive' as const,
        startedAt: 1,
        endedAt: 2,
        ok: true,
        pinned: false,
        summary: 'old answer',
      },
      {
        turnId: 'delta',
        conversationId: 'c',
        seq: 1,
        triggerKind: 'interactive' as const,
        startedAt: 3,
        endedAt: 4,
        ok: true,
        pinned: false,
        summary: 'delta answer',
      },
      {
        turnId: 'running',
        conversationId: 'c',
        seq: 2,
        triggerKind: 'interactive' as const,
        startedAt: 5,
        ok: false,
        pinned: false,
      },
    ];
    const messages = hydrationMessagesFromLedger(
      turns,
      () => [],
      () => [],
      0,
    );
    expect(messages).toEqual([{ payload: { kind: 'ai', text: 'delta answer' }, createdAt: 4 }]);
  });
});
