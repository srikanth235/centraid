// Coverage for resolving an ACP adapter's stdio-server entry from node_modules:
// the happy path (memoized), the "not installed" throw, and the "declares no
// bin" throw.

import { expect, test } from 'vitest';
import { resolveAdapterEntry } from './adapter-bin.ts';

test('resolves and memoizes a real adapter package bin entry', () => {
  // The claude adapter is a pinned dependency of this package; its package.json
  // exposes a `bin` map. Resolving twice must hit the module-level cache and
  // return the identical absolute path.
  const first = resolveAdapterEntry('@agentclientprotocol/claude-agent-acp');
  const second = resolveAdapterEntry('@agentclientprotocol/claude-agent-acp');
  expect(first).toBe(second);
  expect(first).toMatch(/claude-agent-acp/);
  expect(first.endsWith('.js')).toBe(true);
});

test('throws an actionable error when the adapter package is not installed', () => {
  expect(() => resolveAdapterEntry('@centraid/definitely-not-a-real-adapter')).toThrow(
    /is not installed/,
  );
});

test('throws when the resolved package declares no bin entry', () => {
  // `ms` is a transitive dependency with a valid package.json but no `bin`.
  expect(() => resolveAdapterEntry('ms')).toThrow(/declares no bin entry/);
});
