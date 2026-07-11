/*
 * The conformance kit (PROTOCOL.md § Conformance): "the reference
 * conformance kit lives in Centraid's packages/backup (conformance.ts) and
 * runs the same assertions against any BackupProvider implementation ...
 * The kit is the definition of this protocol; where prose and kit disagree,
 * fix whichever is wrong loudly."
 *
 * Framework-agnostic on purpose (`node:assert/strict`, not vitest) — this
 * package's own tests consume it under vitest, but a third-party provider's
 * CI can run these cases under anything that can call an async function and
 * catch a thrown error.
 */

import assert from 'node:assert/strict';
import type { BackupProvider } from './provider.js';
import { BackupProviderError } from './provider.js';

export interface ConformanceCase {
  name: string;
  run: () => Promise<void>;
}

export interface ConformanceHarness {
  provider: BackupProvider;
  cleanup: () => Promise<void>;
}

async function withProvider(
  makeProvider: () => Promise<ConformanceHarness>,
  fn: (provider: BackupProvider) => Promise<void>,
): Promise<void> {
  const { provider, cleanup } = await makeProvider();
  try {
    await fn(provider);
  } finally {
    await cleanup();
  }
}

async function expectError(fn: () => Promise<unknown>): Promise<BackupProviderError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(
      err instanceof BackupProviderError,
      `expected a BackupProviderError, got ${String(err)}`,
    );
    return err;
  }
  throw new Error('expected a BackupProviderError to be thrown, nothing was');
}

/**
 * The grading suite. Each case is self-contained (calls `makeProvider()`
 * itself) so cases can run in any order/isolation without sharing state.
 */
export function providerConformanceCases(
  makeProvider: () => Promise<ConformanceHarness>,
): ConformanceCase[] {
  return [
    {
      name: 'capabilities sanity',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const caps = await provider.capabilities();
          assert.ok(
            caps.protocol.includes('centraid-backup-provider/1'),
            'protocol must declare centraid-backup-provider/1',
          );
          assert.equal(caps.dataPlane, 's3');
          assert.ok(caps.maxCredentialTtlSeconds > 0);
          assert.ok(caps.softDeleteWindowDays > 0);
          assert.ok(['free-egress', 'metered-egress'].includes(caps.restoreCostClass));
          assert.ok(['api-key', 'interactive'].includes(caps.purgeAuthTier));
          if (caps.retention.kind === 'ladder') {
            assert.equal(
              caps.retention.neverPruneNewest,
              true,
              'retention.neverPruneNewest MUST be true',
            );
          }
        }),
    },

    {
      name: 'target lifecycle',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const { targetId } = await provider.createTarget({ label: 'conformance-target' });
          assert.ok(targetId.length > 0);
          const info = await provider.getTarget(targetId);
          assert.equal(info.id, targetId);
          assert.equal(info.status, 'active');
          assert.equal(info.currentGeneration, 0);
          assert.ok(info.usage);
        }),
    },

    {
      name: 'data-plane roundtrip via openDataPlane',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const { targetId } = await provider.createTarget({ label: 'dp' });
          const rw = await provider.openDataPlane(targetId, 'read-write');
          const payload = new TextEncoder().encode('hello conformance');
          await rw.put('chunks/probe', payload);
          const got = await rw.get('chunks/probe');
          assert.deepEqual([...got], [...payload]);
          const head = await rw.head('chunks/probe');
          assert.equal(head?.size, payload.length);
          const listed: string[] = [];
          for await (const obj of rw.list('chunks/')) listed.push(obj.key);
          assert.ok(listed.includes('chunks/probe'));
          await rw.delete('chunks/probe');
          assert.equal(await rw.head('chunks/probe'), null);

          const ro = await provider.openDataPlane(targetId, 'read');
          await assert.rejects(
            () => ro.put('chunks/nope', payload),
            'read-mode store must refuse put',
          );
        }),
    },

    {
      name: 'registration + idempotency replay',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const { targetId } = await provider.createTarget({ label: 'idem' });
          const reg = {
            idempotencyKey: 'idem-key-1',
            manifestKey: 'manifests/1-aaaaaaaa.json',
            manifestHash: 'a'.repeat(64),
            totalBytes: 100,
            objectCount: 1,
            generation: 1,
            format: 'centraid-snapshot/1',
            appMeta: { gatewayVersion: '0.1.0' },
          };
          const first = await provider.registerSnapshot(targetId, reg);
          // Wire timestamps are unix epoch seconds (integers) — PROTOCOL.md.
          assert.ok(Number.isInteger(first.createdAt), 'createdAt must be an epoch-second integer');
          assert.equal(first.prunedAt, null);
          const replay = await provider.registerSnapshot(targetId, {
            ...reg,
            manifestKey: 'manifests/DIFFERENT.json', // provider must ignore this and replay `first`
          });
          assert.deepEqual(
            replay,
            first,
            'idempotency replay must return the cached row unchanged',
          );
        }),
    },

    {
      name: 'generation fencing',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const { targetId } = await provider.createTarget({ label: 'fence' });
          const base = {
            manifestHash: 'b'.repeat(64),
            totalBytes: 1,
            objectCount: 1,
            format: 'centraid-snapshot/1',
            appMeta: {},
          };
          const r1 = await provider.registerSnapshot(targetId, {
            ...base,
            idempotencyKey: 'g2',
            manifestKey: 'manifests/g2.json',
            generation: 2,
          });
          assert.equal(r1.generation, 2);

          const err = await expectError(() =>
            provider.registerSnapshot(targetId, {
              ...base,
              idempotencyKey: 'g1-stale',
              manifestKey: 'manifests/g1.json',
              generation: 1,
            }),
          );
          assert.equal(err.code, 'conflict_generation');
          assert.equal(err.details?.currentGeneration, 2);

          const r2 = await provider.registerSnapshot(targetId, {
            ...base,
            idempotencyKey: 'g2-equal',
            manifestKey: 'manifests/g2b.json',
            generation: 2,
          });
          assert.equal(
            r2.generation,
            2,
            'registration with generation === currentGeneration MUST succeed',
          );

          const r3 = await provider.registerSnapshot(targetId, {
            ...base,
            idempotencyKey: 'g5-higher',
            manifestKey: 'manifests/g5.json',
            generation: 5,
          });
          assert.equal(
            r3.generation,
            5,
            'registration with a higher generation MUST succeed and bump currentGeneration',
          );
        }),
    },

    {
      name: 'seq monotonicity and list newest-first',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const { targetId } = await provider.createTarget({ label: 'seq' });
          const seqs: number[] = [];
          for (let i = 0; i < 3; i++) {
            const row = await provider.registerSnapshot(targetId, {
              idempotencyKey: `seq-${i}`,
              manifestKey: `manifests/seq-${i}.json`,
              manifestHash: `${i}`.repeat(64).slice(0, 64),
              totalBytes: 1,
              objectCount: 1,
              generation: i + 1,
              format: 'centraid-snapshot/1',
              appMeta: {},
            });
            seqs.push(row.seq);
          }
          for (let i = 1; i < seqs.length; i++) {
            assert.ok(
              (seqs[i] as number) > (seqs[i - 1] as number),
              'seq must be strictly increasing',
            );
          }
          const rows = await provider.listSnapshots(targetId);
          const listedSeqs = rows.map((r) => r.seq);
          const sortedDesc = [...listedSeqs].sort((a, b) => b - a);
          assert.deepEqual(listedSeqs, sortedDesc, 'listSnapshots must return newest-first');

          const withPruned = await provider.listSnapshots(targetId, { includePruned: true });
          assert.ok(withPruned.length >= rows.length, 'includePruned must never return fewer rows');
        }),
    },

    {
      name: 'getSnapshot',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const { targetId } = await provider.createTarget({ label: 'get1' });
          const row = await provider.registerSnapshot(targetId, {
            idempotencyKey: 'get1-k',
            manifestKey: 'manifests/get1.json',
            manifestHash: 'c'.repeat(64),
            totalBytes: 1,
            objectCount: 1,
            generation: 1,
            format: 'centraid-snapshot/1',
            appMeta: {},
          });
          const fetched = await provider.getSnapshot(targetId, row.seq);
          assert.deepEqual(fetched, row);
          await expectError(() => provider.getSnapshot(targetId, row.seq + 999));
        }),
    },

    {
      name: 'soft-delete then undelete lifecycle',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const { targetId } = await provider.createTarget({ label: 'del1' });
          await provider.deleteTarget(targetId);
          await provider.undeleteTarget(targetId);
          const info = await provider.getTarget(targetId);
          assert.equal(info.status, 'active', 'undelete within the window must restore the target');
        }),
    },

    {
      name: 'purge (tier-gated)',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const caps = await provider.capabilities();
          const { targetId } = await provider.createTarget({ label: 'purge1' });
          if (caps.purgeAuthTier === 'api-key') {
            await provider.purgeTarget(targetId); // MUST succeed
          } else {
            const err = await expectError(() => provider.purgeTarget(targetId));
            assert.equal(err.code, 'interactive_auth_required');
          }
        }),
    },

    {
      name: 'usage shape',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const { targetId } = await provider.createTarget({ label: 'usage1' });
          const { usage, accountStatus } = await provider.usage(targetId);
          assert.ok(['ok', 'payment_due', 'suspended'].includes(accountStatus));
          assert.equal(typeof usage.storedBytes, 'number');
          assert.equal(typeof usage.objectCount, 'number');
          // quotaBytes / meteredAt are OPTIONAL (a provider may not meter or
          // cap); when present, meteredAt is an epoch-second integer.
          if (usage.quotaBytes !== undefined) {
            assert.equal(typeof usage.quotaBytes, 'number');
          }
          if (usage.meteredAt !== undefined) {
            assert.ok(
              Number.isInteger(usage.meteredAt),
              'meteredAt must be an epoch-second integer when present',
            );
          }
        }),
    },
  ];
}
