import { expect, test } from 'vitest';
import { lowPriorityCommand } from './low-priority.js';

test('Linux children get ionice plus nice when available', () => {
  expect(
    lowPriorityCommand('codex', ['exec'], {
      platform: 'linux',
      exists: (file) => file === '/usr/bin/nice' || file === '/usr/bin/ionice',
    }),
  ).toEqual({
    bin: '/usr/bin/ionice',
    args: ['-c', '2', '-n', '7', '/usr/bin/nice', '-n', '10', '--', 'codex', 'exec'],
  });
});

test('Windows keeps the command unchanged', () => {
  expect(lowPriorityCommand('codex.exe', ['exec'], { platform: 'win32' })).toEqual({
    bin: 'codex.exe',
    args: ['exec'],
  });
});

test('niceness defaults to 10 and is overridable per call (#528 Phase D)', () => {
  // Default increment unchanged for existing call sites.
  expect(
    lowPriorityCommand('codex', ['exec'], {
      platform: 'darwin',
      exists: (file) => file === '/usr/bin/nice',
    }),
  ).toEqual({ bin: '/usr/bin/nice', args: ['-n', '10', '--', 'codex', 'exec'] });

  // An explicit niceness flows through to the nice increment.
  expect(
    lowPriorityCommand('codex', ['exec'], {
      platform: 'darwin',
      exists: (file) => file === '/usr/bin/nice',
      niceness: 19,
    }),
  ).toEqual({ bin: '/usr/bin/nice', args: ['-n', '19', '--', 'codex', 'exec'] });

  // Windows still ignores it (no wrapper).
  expect(lowPriorityCommand('codex.exe', ['exec'], { platform: 'win32', niceness: 5 })).toEqual({
    bin: 'codex.exe',
    args: ['exec'],
  });
});
