import { describe, it, expect } from 'vitest';
import { lineDiff } from './diff.js';

describe('lineDiff', () => {
  it('marks every line `same` when the texts are identical', () => {
    const rows = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(rows).toEqual([
      { type: 'same', text: 'a', aNum: 1, bNum: 1 },
      { type: 'same', text: 'b', aNum: 2, bNum: 2 },
      { type: 'same', text: 'c', aNum: 3, bNum: 3 },
    ]);
  });

  it('reports a pure insertion as `add` rows carrying only the b-side number', () => {
    const rows = lineDiff('a\nc', 'a\nb\nc');
    expect(rows).toEqual([
      { type: 'same', text: 'a', aNum: 1, bNum: 1 },
      { type: 'add', text: 'b', bNum: 2 },
      { type: 'same', text: 'c', aNum: 2, bNum: 3 },
    ]);
  });

  it('reports a pure deletion as `del` rows carrying only the a-side number', () => {
    const rows = lineDiff('a\nb\nc', 'a\nc');
    expect(rows).toEqual([
      { type: 'same', text: 'a', aNum: 1, bNum: 1 },
      { type: 'del', text: 'b', aNum: 2 },
      { type: 'same', text: 'c', aNum: 3, bNum: 2 },
    ]);
  });

  it('represents a one-line change as a delete followed by an add', () => {
    const rows = lineDiff('hello\nworld', 'hello\nthere');
    expect(rows).toEqual([
      { type: 'same', text: 'hello', aNum: 1, bNum: 1 },
      { type: 'del', text: 'world', aNum: 2 },
      { type: 'add', text: 'there', bNum: 2 },
    ]);
  });

  it('treats an empty original as one empty line, deleted, before the additions', () => {
    // '' splits to [''] — one empty line that has no counterpart in the new text.
    const rows = lineDiff('', 'x\ny');
    expect(rows).toEqual([
      { type: 'del', text: '', aNum: 1 },
      { type: 'add', text: 'x', bNum: 1 },
      { type: 'add', text: 'y', bNum: 2 },
    ]);
  });

  it('deletes every original line and adds one empty line when the new text is empty', () => {
    const rows = lineDiff('x\ny', '');
    expect(rows).toEqual([
      { type: 'del', text: 'x', aNum: 1 },
      { type: 'del', text: 'y', aNum: 2 },
      { type: 'add', text: '', bNum: 1 },
    ]);
  });

  it('keeps the common subsequence maximal across interleaved edits', () => {
    const rows = lineDiff('a\nb\nc\nd', 'a\nx\nc\ny\nd');
    // a, c, d survive as the LCS; b is deleted, x and y are added.
    expect(rows.filter((r) => r.type === 'same').map((r) => r.text)).toEqual(['a', 'c', 'd']);
    expect(rows.filter((r) => r.type === 'del').map((r) => r.text)).toEqual(['b']);
    expect(rows.filter((r) => r.type === 'add').map((r) => r.text)).toEqual(['x', 'y']);
  });

  it('preserves line ordering and renumbers both sides independently', () => {
    const rows = lineDiff('keep\ndrop', 'keep\nadd1\nadd2');
    expect(rows.map((r) => [r.type, r.aNum, r.bNum])).toEqual([
      ['same', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['add', undefined, 3],
    ]);
  });
});
