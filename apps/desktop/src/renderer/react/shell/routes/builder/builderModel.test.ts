import { describe, expect, it } from 'vitest';
import {
  type ConversationMsg,
  parseVersionTime,
  relTime,
  summarizeGroup,
  summarizeToolArgs,
  toBuilderMsg,
  toolVerb,
  turnProgress,
} from './builderModel.js';

describe('toolVerb', () => {
  it('maps known tools and title-cases the rest', () => {
    expect(toolVerb('read')).toBe('Reading');
    expect(toolVerb('multi_edit')).toBe('Editing');
    expect(toolVerb('grep')).toBe('Searching');
    expect(toolVerb('deploy')).toBe('Deploy');
  });
});

describe('summarizeGroup', () => {
  it('collapses adjacent same-verb calls to "Verb ×N"', () => {
    expect(
      summarizeGroup([
        { id: '1', tool: 'read', state: 'ok' },
        { id: '2', tool: 'read', state: 'ok' },
        { id: '3', tool: 'write', state: 'ok' },
      ]),
    ).toBe('Reading ×2, Writing');
  });
});

describe('summarizeToolArgs', () => {
  it('picks the path for file tools and truncates long bash', () => {
    expect(summarizeToolArgs('write', { path: 'a/b.ts' })).toBe('a/b.ts');
    expect(summarizeToolArgs('grep', { pattern: 'foo', path: 'src' })).toBe('foo  in  src');
    expect(summarizeToolArgs('bash', { command: 'x'.repeat(200) })?.endsWith('…')).toBe(true);
    expect(summarizeToolArgs('read', null)).toBeUndefined();
  });
});

describe('toBuilderMsg', () => {
  it('splits AI text into paragraphs', () => {
    expect(toBuilderMsg({ kind: 'ai', text: 'a\n\nb' }, 0)).toEqual({
      kind: 'ai',
      paras: ['a', 'b'],
    });
  });

  it('builds a change card from ok file-writes, versioned by count', () => {
    const m: ConversationMsg = {
      kind: 'toolGroup',
      id: 'g1',
      open: false,
      calls: [
        { id: '1', tool: 'write', state: 'ok', summary: 'src/app.ts' },
        { id: '2', tool: 'read', state: 'ok', summary: 'src/x.ts' },
      ],
    };
    const dto = toBuilderMsg(m, 2);
    if (dto.kind !== 'toolGroup') throw new Error('expected toolGroup');
    expect(dto.change).toEqual({ count: 1, subtitle: 'app.ts', version: 'v3' });
    expect(dto.rows).toEqual([]); // collapsed → no rows
  });
});

describe('turnProgress', () => {
  it('reports the running tool with a determinate dot count', () => {
    const chat: ConversationMsg[] = [
      { kind: 'user', text: 'go' },
      {
        kind: 'toolGroup',
        id: 'g',
        open: true,
        calls: [
          { id: '1', tool: 'read', state: 'ok', summary: 'a' },
          { id: '2', tool: 'write', state: 'running', summary: 'b.ts' },
        ],
      },
    ];
    expect(turnProgress(chat, -1)).toEqual({
      verb: 'Writing',
      file: 'b.ts',
      sub: 'Reading, Writing',
      filled: 2,
    });
  });

  it('reports "Writing" while the reply streams', () => {
    const chat: ConversationMsg[] = [{ kind: 'user', text: 'go' }];
    expect(turnProgress(chat, 3)?.verb).toBe('Writing');
  });
});

describe('relTime / parseVersionTime', () => {
  it('formats coarse relative time', () => {
    const now = 10 * 60 * 60 * 1000;
    expect(relTime(now, now)).toBe('just now');
    expect(relTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relTime(now - 3 * 3_600_000, now)).toBe('3h ago');
  });

  it('parses the ISO stamp embedded in a version id', () => {
    expect(parseVersionTime('v_2026-07-09T14-22-01-abc')).toBe(Date.parse('2026-07-09T14:22:00Z'));
    expect(parseVersionTime('nope')).toBeUndefined();
  });
});
