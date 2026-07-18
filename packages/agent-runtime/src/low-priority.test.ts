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
