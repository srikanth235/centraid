/**
 * Matrix cell agent-runtime.concurrency (#535 coverable-today).
 * lowPriorityCommand is pure per call — concurrent invocations must not share state.
 */
import { expect, test } from 'vitest';
import { lowPriorityCommand } from './low-priority.ts';

test('parallel lowPriorityCommand calls return independent argv arrays', () => {
  const results = Array.from({ length: 32 }, (_, i) =>
    lowPriorityCommand('agent-bin', [`--slot=${i}`, 'run'], {
      platform: 'linux',
      exists: (p) => p === '/usr/bin/nice' || p === '/usr/bin/ionice',
    }),
  );
  expect(results).toHaveLength(32);
  for (let i = 0; i < results.length; i += 1) {
    expect(results[i]!.args.join(' ')).toContain(`--slot=${i}`);
  }
  // Mutating one result's argv must not rewrite sibling arrays.
  results[0]!.args.push('mutated');
  for (let i = 1; i < results.length; i += 1) {
    expect(results[i]!.args).not.toContain('mutated');
    expect(results[i]!.args.join(' ')).toContain(`--slot=${i}`);
  }
});

test('CENTRAID_CHILD_PRIORITY=normal bypass is stable under concurrent reads', () => {
  const prev = process.env.CENTRAID_CHILD_PRIORITY;
  process.env.CENTRAID_CHILD_PRIORITY = 'normal';
  try {
    const results = Array.from({ length: 16 }, () =>
      lowPriorityCommand('bin', ['a'], { platform: 'linux' }),
    );
    for (const cmd of results) {
      expect(cmd).toEqual({ bin: 'bin', args: ['a'] });
    }
  } finally {
    if (prev === undefined) delete process.env.CENTRAID_CHILD_PRIORITY;
    else process.env.CENTRAID_CHILD_PRIORITY = prev;
  }
});
