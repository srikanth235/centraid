import { fc } from '@centraid/test-kit/fast-check';
import { afterEach, describe, expect, test } from 'vitest';

import { lowPriorityCommand } from './low-priority.js';

/**
 * Property defense for lowPriorityCommand (#545 D6 agent-runtime mutation seed).
 *
 * Model: Windows / CENTRAID_CHILD_PRIORITY=normal is identity; otherwise the
 * original bin+args appear after the nice wrapper; niceness is stringified.
 */
describe('lowPriorityCommand properties', () => {
  const prior = process.env.CENTRAID_CHILD_PRIORITY;
  afterEach(() => {
    if (prior === undefined) delete process.env.CENTRAID_CHILD_PRIORITY;
    else process.env.CENTRAID_CHILD_PRIORITY = prior;
  });

  const binArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9._-]{0,12}$/u);
  const argsArb = fc.array(fc.stringMatching(/^[A-Za-z0-9._-]{1,8}$/u), {
    maxLength: 4,
  });

  test('win32 is always identity regardless of niceness or exists', () => {
    fc.assert(
      fc.property(binArb, argsArb, fc.integer({ min: 0, max: 19 }), (bin, args, niceness) => {
        expect(
          lowPriorityCommand(bin, args, {
            platform: 'win32',
            niceness,
            exists: () => true,
          }),
        ).toStrictEqual({ bin, args: [...args] });
      }),
      { numRuns: 32, seed: 54516 },
    );
  });

  test('CENTRAID_CHILD_PRIORITY=normal is identity on non-Windows', () => {
    process.env.CENTRAID_CHILD_PRIORITY = 'normal';
    fc.assert(
      fc.property(binArb, argsArb, (bin, args) => {
        expect(
          lowPriorityCommand(bin, args, {
            platform: 'darwin',
            exists: () => true,
          }),
        ).toStrictEqual({ bin, args: [...args] });
      }),
      { numRuns: 24, seed: 54517 },
    );
  });

  test('darwin wraps with nice and preserves bin+args after --', () => {
    delete process.env.CENTRAID_CHILD_PRIORITY;
    fc.assert(
      fc.property(binArb, argsArb, fc.integer({ min: 1, max: 19 }), (bin, args, niceness) => {
        const cmd = lowPriorityCommand(bin, args, {
          platform: 'darwin',
          niceness,
          exists: (file) => file === '/usr/bin/nice',
        });
        expect(cmd.bin).toBe('/usr/bin/nice');
        expect(cmd.args).toStrictEqual(['-n', String(niceness), '--', bin, ...args]);
      }),
      { numRuns: 32, seed: 54518 },
    );
  });

  // The ionice/nice choice is split into one property per branch so both sets
  // of assertions always run — a single property with an `if` could have
  // silently exercised only one arm.
  test('linux prefers ionice when it is present', () => {
    delete process.env.CENTRAID_CHILD_PRIORITY;
    fc.assert(
      fc.property(binArb, argsArb, (bin, args) => {
        const cmd = lowPriorityCommand(bin, args, {
          platform: 'linux',
          exists: (file) => file === '/usr/bin/nice' || file === '/usr/bin/ionice',
        });
        expect(cmd.bin).toBe('/usr/bin/ionice');
        expect(cmd.args.slice(0, 4)).toStrictEqual(['-c', '2', '-n', '7']);
        expect(cmd.args.slice(-args.length - 1)).toStrictEqual([bin, ...args]);
      }),
      { numRuns: 32, seed: 54519 },
    );
  });

  test('linux falls back to nice alone when ionice is absent', () => {
    delete process.env.CENTRAID_CHILD_PRIORITY;
    fc.assert(
      fc.property(binArb, argsArb, (bin, args) => {
        const cmd = lowPriorityCommand(bin, args, {
          platform: 'linux',
          exists: (file) => file === '/usr/bin/nice',
        });
        expect(cmd.bin).toBe('/usr/bin/nice');
        expect(cmd.args.at(-args.length - 1)).toBe(bin);
      }),
      { numRuns: 32, seed: 54520 },
    );
  });
});
