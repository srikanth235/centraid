/*
 * Layer 2 — `derived` store conformance cases (PROTOCOL.md § derived store
 * semantics). Split out of `conformance.ts` because that file is at the
 * repo-hygiene 500-line cap; spread back in there next to the observability
 * cases. Same framework-agnostic discipline (`node:assert/strict`).
 *
 * The `derived` store is Layer-2 workload semantics in the exact mold of
 * `cas`: a grant plus plain S3 operations against an isolated prefix, no new
 * control-plane routes. These cases run offline against ANY provider through
 * `openDataPlane`, and skip cleanly when the `derived` capability is absent.
 */

import assert from 'node:assert/strict';
import type { ConformanceCase, ConformanceHarness } from './conformance.js';

const TEXT = new TextEncoder();

async function withHarness(
  make: () => Promise<ConformanceHarness>,
  run: (harness: ConformanceHarness) => Promise<void>,
): Promise<void> {
  const harness = await make();
  try {
    await run(harness);
  } finally {
    await harness.cleanup();
  }
}

/** Capability-gated `derived` store grading cases. */
export function providerDerivedConformanceCases(
  makeProvider: () => Promise<ConformanceHarness>,
): ConformanceCase[] {
  return [
    {
      name: 'derived: put/list/get/delete round-trip',
      run: () =>
        withHarness(makeProvider, async ({ provider }) => {
          const caps = await provider.capabilities();
          if (!caps.capabilities.includes('derived')) return; // capability not offered — skip cleanly
          const { targetId } = await provider.createTarget({ label: 'derived-roundtrip' });
          const rw = await provider.openDataPlane(targetId, 'derived', 'read-write');
          // Display derivative key layout is the client's own; the provider
          // round-trips opaque bytes (thumb/preview/poster and future rungs).
          const key = `thumb/${'ab'.repeat(32)}`;
          const payload = TEXT.encode('opaque sealed derivative bytes');
          await rw.put(key, payload);
          const got = await rw.get(key);
          assert.deepEqual([...got], [...payload]);
          const listed: string[] = [];
          for await (const obj of rw.list('thumb/')) listed.push(obj.key);
          assert.ok(listed.includes(key), 'derived grants MUST include list permission');
          await rw.delete(key);
          assert.equal(await rw.head(key), null, 'delete allowed via read-write grant');
        }),
    },

    {
      name: 'derived, backup, and cas stores occupy disjoint namespaces',
      run: () =>
        withHarness(makeProvider, async ({ provider }) => {
          const caps = await provider.capabilities();
          if (!caps.capabilities.includes('derived')) return; // skip cleanly
          const { targetId } = await provider.createTarget({ label: 'derived-disjoint' });
          const derivedStore = await provider.openDataPlane(targetId, 'derived', 'read-write');
          // Write the SAME key to every granted store, then assert isolation:
          // no store can observe another's object under that shared key.
          await derivedStore.put('probe', TEXT.encode('derived-side'));
          const backupStore = await provider.openDataPlane(targetId, 'backup', 'read-write');
          await backupStore.put('probe', TEXT.encode('backup-side'));
          assert.equal(
            new TextDecoder().decode(await derivedStore.get('probe')),
            'derived-side',
            'the backup store MUST NOT overwrite the derived store under a shared key',
          );
          if (caps.capabilities.includes('cas')) {
            const casStore = await provider.openDataPlane(targetId, 'cas', 'read-write');
            assert.equal(
              await casStore.head('probe'),
              null,
              'writing to derived/backup must not be visible from the cas store',
            );
            await casStore.put('probe', TEXT.encode('cas-side'));
            assert.equal(
              new TextDecoder().decode(await derivedStore.get('probe')),
              'derived-side',
              'the cas store MUST NOT overwrite the derived store under a shared key',
            );
          }
        }),
    },

    {
      name: 'grant layer: derived grant echoes store + prefix disjoint from backup and cas',
      run: () =>
        withHarness(makeProvider, async ({ provider }) => {
          if (!provider.requestGrant) return; // grant concept not offered — skip cleanly
          const caps = await provider.capabilities();
          if (!caps.capabilities.includes('derived')) return; // skip cleanly
          const { targetId } = await provider.createTarget({ label: 'derived-grant' });
          const derivedGrant = await provider.requestGrant(targetId, 'derived', 'read-write');
          assert.equal(derivedGrant.store, 'derived', 'grant must echo the requested store class');
          assert.ok(derivedGrant.region.length > 0, 'region must be present');
          const backupGrant = await provider.requestGrant(targetId, 'backup', 'read-write');
          assert.notEqual(
            derivedGrant.prefix,
            backupGrant.prefix,
            'the derived store MUST get a prefix disjoint from backup',
          );
          if (caps.capabilities.includes('cas')) {
            const casGrant = await provider.requestGrant(targetId, 'cas', 'read-write');
            assert.notEqual(
              derivedGrant.prefix,
              casGrant.prefix,
              'the derived store MUST get a prefix disjoint from cas',
            );
          }
        }),
    },
  ];
}
