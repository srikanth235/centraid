// Unified line diff (LCS) that drives the Code view's Diff toggle — extracted
// from the builder god-file for unit testing (TESTING.md §2). Pure: it maps two
// strings to a row list, no DOM. O(mn) time/space is fine here because
// `readAppFiles` caps app files at 256 KB.

export type DiffRow = {
  type: 'same' | 'add' | 'del';
  text: string;
  aNum?: number;
  bNum?: number;
};

/**
 * Diff two texts line-by-line via longest-common-subsequence backtracking.
 * Returns one row per line: `same` lines carry both line numbers, `del` carries
 * the left number, `add` carries the right.
 */
export function lineDiff(aStr: string, bStr: string): DiffRow[] {
  const a = aStr.split('\n');
  const b = bStr.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from<number>({ length: n + 1 }).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let an = 1;
  let bn = 1;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i]!, aNum: an++, bNum: bn++ });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ type: 'del', text: a[i]!, aNum: an++ });
      i++;
    } else {
      rows.push({ type: 'add', text: b[j]!, bNum: bn++ });
      j++;
    }
  }
  while (i < m) rows.push({ type: 'del', text: a[i++]!, aNum: an++ });
  while (j < n) rows.push({ type: 'add', text: b[j++]!, bNum: bn++ });
  return rows;
}
