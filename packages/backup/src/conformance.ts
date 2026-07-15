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

const TEXT = new TextEncoder();

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

/**
 * `manifestKey` MUST fall under the target's `backup` store prefix
 * (PROTOCOL.md "Snapshot registration" — the same `u/{id}/backup/` the
 * credential grant's own `prefix` uses; see `engine.ts`'s `createSnapshot`).
 * A bare `manifests/…` key is protocol-invalid input — a conformant
 * provider MUST 400 it with `invalid_manifest_key` — so every case below
 * that registers a snapshot must build a key shaped like this, not a bare
 * one, to stay a valid grading input for ANY conformant provider rather
 * than only the two reference ones in this package (which happen not to
 * enforce the prefix).
 */
function manifestKeyFor(targetId: string, name: string): string {
  return `u/${targetId}/backup/manifests/${name}`;
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
            caps.protocol.includes('centraid-storage-provider/1'),
            'protocol must declare centraid-storage-provider/1',
          );
          assert.equal(caps.dataPlane, 's3');
          assert.ok(caps.maxCredentialTtlSeconds > 0);
          assert.ok(['api-key', 'interactive'].includes(caps.purgeAuthTier));
          assert.ok(Array.isArray(caps.capabilities), 'capabilities must declare an array');
          for (const flag of caps.capabilities) {
            assert.ok(
              ['backup', 'cas', 'usage'].includes(flag),
              `unknown capability flag "${flag}"`,
            );
          }
          if (caps.capabilities.includes('backup')) {
            assert.ok(
              caps.backup,
              '"backup" capability declared but `backup` discovery block missing',
            );
            assert.ok(caps.backup.softDeleteWindowDays > 0);
            assert.ok(['free-egress', 'metered-egress'].includes(caps.backup.restoreCostClass));
            if (caps.backup.retention.kind === 'ladder') {
              assert.equal(
                caps.backup.retention.neverPruneNewest,
                true,
                'retention.neverPruneNewest MUST be true',
              );
            }
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
      name: 'data-plane roundtrip via openDataPlane (backup store)',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const { targetId } = await provider.createTarget({ label: 'dp' });
          const rw = await provider.openDataPlane(targetId, 'backup', 'read-write');
          const payload = TEXT.encode('hello conformance');
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

          const ro = await provider.openDataPlane(targetId, 'backup', 'read');
          await assert.rejects(
            () => ro.put('chunks/nope', payload),
            'read-mode store must refuse put',
          );
        }),
    },

    {
      // centraid-snapshot/1 (issue #408) stores WAL segments as plain
      // data-plane objects under `wal/…` — providers never parse them, but
      // MUST round-trip the deeper key shape and serve ordered prefix LISTs
      // (restore planning is a LIST, no per-object reads).
      name: 'data-plane wal-segment namespace: deep keys round-trip + prefix list',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const { targetId } = await provider.createTarget({ label: 'wal' });
          const rw = await provider.openDataPlane(targetId, 'backup', 'read-write');
          const gen = 'ab'.repeat(16);
          const jgen = 'cd'.repeat(16);
          const keys = [
            `wal/vault/${gen}/00000000/000000000000-000000004128-1752480000000`,
            `wal/vault/${gen}/00000000/000000004128-000000008256-1752480060000`,
            `wal/vault/${gen}/00000000/closed-000000008256`,
            `wal/vault/${gen}/00000001/000000000000-000000004128-1752480120000`,
            `wal/journal/${gen}/00000000/000000000000-000000004128-1752480000000`,
            // The pair marker lives OUTSIDE the per-database prefixes — its key
            // names BOTH generations, so it must round-trip and list under its
            // own namespace or a restore has no coordinated cut to aim at.
            `wal/tick/${gen}-${jgen}/1752480060000`,
          ];
          for (const key of keys) await rw.put(key, TEXT.encode(key));
          const listed: string[] = [];
          for await (const obj of rw.list(`wal/vault/${gen}/`)) listed.push(obj.key);
          assert.deepEqual(
            [...listed].sort(),
            keys.slice(0, 4).sort(),
            'prefix list must return exactly the vault generation objects',
          );
          const markers: string[] = [];
          for await (const obj of rw.list(`wal/tick/${gen}-${jgen}/`)) markers.push(obj.key);
          assert.deepEqual(markers, [keys[5]], 'pair-marker prefix list must return the marker');
          const got = await rw.get(keys[1]!);
          assert.equal(new TextDecoder().decode(got), keys[1]);
          for (const key of keys) await rw.delete(key);
          assert.equal(await rw.head(keys[0]!), null);
        }),
    },

    {
      name: 'registration + idempotency replay',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const { targetId } = await provider.createTarget({ label: 'idem' });
          const reg = {
            idempotencyKey: 'idem-key-1',
            manifestKey: manifestKeyFor(targetId, '1-aaaaaaaa.json'),
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
            manifestKey: manifestKeyFor(targetId, 'DIFFERENT.json'), // provider must ignore this and replay `first`
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
            manifestKey: manifestKeyFor(targetId, 'g2.json'),
            generation: 2,
          });
          assert.equal(r1.generation, 2);

          const err = await expectError(() =>
            provider.registerSnapshot(targetId, {
              ...base,
              idempotencyKey: 'g1-stale',
              manifestKey: manifestKeyFor(targetId, 'g1.json'),
              generation: 1,
            }),
          );
          assert.equal(err.code, 'conflict_generation');
          assert.equal(err.details?.currentGeneration, 2);

          const r2 = await provider.registerSnapshot(targetId, {
            ...base,
            idempotencyKey: 'g2-equal',
            manifestKey: manifestKeyFor(targetId, 'g2b.json'),
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
            manifestKey: manifestKeyFor(targetId, 'g5.json'),
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
              manifestKey: manifestKeyFor(targetId, `seq-${i}.json`),
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
            manifestKey: manifestKeyFor(targetId, 'get1.json'),
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

    // -- Layer 1: grant-layer cases -----------------------------------------
    // `requestGrant` is OPTIONAL (PROTOCOL.md § Layer 1) — only providers with
    // a literal wire-grant concept implement it (e.g. a filesystem provider's
    // data plane IS the caller's own custody, so it has nothing to grant).
    // Skip cleanly, not fail, when absent.

    {
      name: 'grant layer: per-store region + store echoed + disjoint prefixes',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          if (!provider.requestGrant) return; // capability not offered — skip cleanly
          const { targetId } = await provider.createTarget({ label: 'grant-layer' });
          const backupGrant = await provider.requestGrant(targetId, 'backup', 'read-write');
          const casGrant = await provider.requestGrant(targetId, 'cas', 'read-write');
          assert.equal(backupGrant.store, 'backup', 'grant must echo the requested store class');
          assert.equal(casGrant.store, 'cas', 'grant must echo the requested store class');
          assert.ok(backupGrant.region.length > 0, 'region must be present');
          assert.ok(casGrant.region.length > 0, 'region must be present');
          assert.notEqual(
            backupGrant.prefix,
            casGrant.prefix,
            'each store class MUST get an isolated prefix',
          );
        }),
    },

    // -- Layer 2: cas store cases --------------------------------------------
    // Generic through `openDataPlane` (like the backup roundtrip above) so
    // this runs offline against ANY provider, local or remote — for a
    // remote-backed harness this transitively exercises real S3-compatible
    // HTTP via the shared S3 test server (see `testing/s3-test-server.ts`).

    {
      name: 'cas: put/list/get/delete round-trip',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const caps = await provider.capabilities();
          if (!caps.capabilities.includes('cas')) return; // capability not offered — skip cleanly
          const { targetId } = await provider.createTarget({ label: 'cas-roundtrip' });
          const rw = await provider.openDataPlane(targetId, 'cas', 'read-write');
          const key = `blobs/${'ab'.repeat(32)}`; // sha256-hex-shaped key (FORMAT.md-agnostic; cas's own key layout)
          const payload = TEXT.encode('opaque sealed ciphertext');
          await rw.put(key, payload);
          const got = await rw.get(key);
          assert.deepEqual([...got], [...payload]);
          const listed: string[] = [];
          for await (const obj of rw.list('blobs/')) listed.push(obj.key);
          assert.ok(listed.includes(key), 'cas grants MUST include list permission');
          await rw.delete(key);
          assert.equal(await rw.head(key), null, 'delete allowed via read-write grant');
        }),
    },

    {
      name: 'cas and backup stores occupy disjoint namespaces',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const caps = await provider.capabilities();
          if (!caps.capabilities.includes('cas')) return; // skip cleanly
          const { targetId } = await provider.createTarget({ label: 'cas-disjoint' });
          const backupStore = await provider.openDataPlane(targetId, 'backup', 'read-write');
          const casStore = await provider.openDataPlane(targetId, 'cas', 'read-write');
          await backupStore.put('probe', TEXT.encode('backup-side'));
          assert.equal(
            await casStore.head('probe'),
            null,
            'writing to the backup store must not be visible from the cas store',
          );
        }),
    },

    // -- Layer 1: usage cases -------------------------------------------------

    {
      name: 'usage report: skip cleanly when capability absent, shape + monotonic bytes when present',
      run: () =>
        withProvider(makeProvider, async (provider) => {
          const caps = await provider.capabilities();
          if (!caps.capabilities.includes('usage') || !provider.usageReport) return; // skip cleanly
          const { targetId } = await provider.createTarget({ label: 'usage-report' });

          const before = await provider.usageReport(targetId);
          for (const store of Object.keys(before) as (keyof typeof before)[]) {
            const report = before[store];
            if (!report) continue;
            assert.equal(typeof report.bytesStored, 'number');
            assert.equal(typeof report.objectCount, 'number');
            assert.ok(
              report.quotaBytes === null || typeof report.quotaBytes === 'number',
              'quotaBytes must be a number or null (unmetered)',
            );
            assert.ok(Number.isInteger(report.period.start));
            assert.ok(Number.isInteger(report.period.end));
          }

          const rw = await provider.openDataPlane(targetId, 'backup', 'read-write');
          await rw.put('chunks/usage-probe', TEXT.encode('x'.repeat(1024)));
          const after = await provider.usageReport(targetId);
          const beforeBytes = before.backup?.bytesStored ?? 0;
          const afterBytes = after.backup?.bytesStored ?? 0;
          assert.ok(
            afterBytes >= beforeBytes,
            'bytesStored must be monotonic non-decreasing after a put',
          );
        }),
    },
  ];
}
