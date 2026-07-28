import assert from 'node:assert/strict';

import type { ConformanceCase, ConformanceHarness } from './conformance.js';
import type { ObjectListEntry } from './object-store.js';
import {
  BackupProviderError,
  type BackupProvider,
  type ProviderAuditEvent,
  type ProviderInventoryObject,
  type ProviderPolicyDeclaration,
  type StoreClass,
} from './provider.js';

const TEXT = new TextEncoder();
const POLICY: ProviderPolicyDeclaration = {
  rpoSeconds: 60,
  snapshotIntervalHours: 24,
  verifyEveryDays: 7,
  casAck: 'receipt',
};

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

async function expectProviderError(run: () => Promise<unknown>): Promise<BackupProviderError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof BackupProviderError, 'expected BackupProviderError');
    return error;
  }
  throw new Error('expected BackupProviderError');
}

async function collectInventory(
  provider: BackupProvider,
  targetId: string,
  store: StoreClass,
  since?: number,
): Promise<ProviderInventoryObject[]> {
  assert.ok(provider.listInventory, 'inventory capability requires listInventory');
  const listInventory = provider.listInventory.bind(provider);
  const out: ProviderInventoryObject[] = [];
  const seenCursors = new Set<string>();
  async function collectPage(cursor: string | undefined): Promise<void> {
    const page = await listInventory(targetId, {
      store,
      limit: 2,
      cursor,
      since,
    });
    assert.equal(page.store, store);
    out.push(...page.objects);
    const next = page.nextCursor ?? undefined;
    if (next) {
      assert.ok(!seenCursors.has(next), 'inventory cursor must advance');
      seenCursors.add(next);
      return collectPage(next);
    }
  }
  await collectPage(undefined);
  return out;
}

async function collectEvents(
  provider: BackupProvider,
  targetId: string,
  since?: number,
): Promise<ProviderAuditEvent[]> {
  assert.ok(provider.listEvents, 'audit capability requires listEvents');
  const listEvents = provider.listEvents.bind(provider);
  const out: ProviderAuditEvent[] = [];
  async function collectPage(cursor: string | undefined): Promise<void> {
    const page = await listEvents(targetId, { limit: 1, cursor, since });
    out.push(...page.events);
    const next = page.nextCursor ?? undefined;
    if (next) return collectPage(next);
  }
  await collectPage(undefined);
  return out;
}

/** Capability-gated policy, inventory, and audit grading cases. */
export function providerObservabilityConformanceCases(
  makeProvider: () => Promise<ConformanceHarness>,
): ConformanceCase[] {
  return [
    {
      name: 'policy: round-trip, replacement drift, stale clock, and typed rejection',
      run: () =>
        withHarness(makeProvider, async ({ provider }) => {
          const caps = await provider.capabilities();
          if (!caps.capabilities.includes('policy')) return;
          assert.ok(provider.putPolicy && provider.getPolicy, 'policy methods must be present');
          const { targetId } = await provider.createTarget({ label: 'policy' });
          const before = Math.floor(Date.now() / 1000);
          const declared = await provider.putPolicy(targetId, POLICY);
          const after = Math.floor(Date.now() / 1000);
          const { declaredAt, ...echo } = declared;
          assert.deepEqual(echo, POLICY);
          assert.ok(Number.isInteger(declaredAt));
          assert.ok(declaredAt >= before && declaredAt <= after);
          assert.deepEqual(await provider.getPolicy(targetId), declared);
          assert.equal(declaredAt + 2 * declared.rpoSeconds, declaredAt + 120);

          const replacement = await provider.putPolicy(targetId, {
            ...POLICY,
            rpoSeconds: 900,
          });
          assert.equal((await provider.getPolicy(targetId)).rpoSeconds, 900);
          assert.notDeepEqual(
            replacement,
            declared,
            'a replacement must be visible as policy drift',
          );

          const rejected = await expectProviderError(() =>
            provider.putPolicy!(targetId, { ...POLICY, rpoSeconds: 29 }),
          );
          assert.equal(rejected.code, 'policy_unmet');
          assert.equal(rejected.status, 422);
          assert.equal(rejected.details?.field, 'rpoSeconds');
          // PROTOCOL.md § "Declared policy" makes 30 the *protocol floor* for
          // rpoSeconds — a lower bound. A provider MAY enforce a stricter
          // (higher) business floor and report that as the violated minimum, so
          // the reported minimum must be at least the protocol floor, not
          // exactly it. (rpoSeconds: 29 is below every conformant floor.)
          assert.ok(
            typeof rejected.details?.minimum === 'number' && rejected.details.minimum >= 30,
            `rpoSeconds minimum must be >= the protocol floor of 30, got ${String(rejected.details?.minimum)}`,
          );
        }),
    },
    {
      name: 'inventory: pagination, since, shape, and raw bucket consistency',
      run: () =>
        withHarness(makeProvider, async ({ provider }) => {
          const caps = await provider.capabilities();
          if (!caps.capabilities.includes('inventory')) return;
          assert.ok(provider.listInventory, 'inventory method must be present');
          const { targetId } = await provider.createTarget({
            label: 'inventory',
          });
          await Promise.all(
            (['backup', 'cas', 'derived'] as const)
              .filter((store) => caps.capabilities.includes(store))
              .map(async (store) => {
                const dataPlane = await provider.openDataPlane(targetId, store, 'read-write');
                await Promise.all(
                  Array.from({ length: 5 }, (_, index) =>
                    dataPlane.put(`objects/${index}`, TEXT.encode(`${store}-${index}`)),
                  ),
                );
                const inventory = await collectInventory(provider, targetId, store);
                const raw: ObjectListEntry[] = [];
                for await (const object of dataPlane.list('')) {
                  raw.push(object);
                }
                assert.deepEqual(
                  inventory.map(({ key, sizeBytes }) => ({ key, sizeBytes })),
                  raw
                    .map(({ key, size }) => ({ key, sizeBytes: size }))
                    .sort((a, b) => a.key.localeCompare(b.key)),
                  'provider inventory must match the granted bucket listing',
                );
                const rawByKey = new Map(raw.map((object) => [object.key, object]));
                for (const object of inventory) {
                  assert.ok(object.etagOrHash.length > 0);
                  assert.ok(Number.isInteger(object.storedAt));
                  assert.equal(object.state, 'live');
                  const listed = rawByKey.get(object.key)!;
                  if (listed.etagOrHash) assert.equal(object.etagOrHash, listed.etagOrHash);
                  if (listed.storedAt !== undefined) assert.equal(object.storedAt, listed.storedAt);
                  if (listed.storageClass) assert.equal(object.storageClass, listed.storageClass);
                }
                const newest = Math.max(...inventory.map((object) => object.storedAt));
                const incremental = await collectInventory(provider, targetId, store, newest);
                assert.ok(incremental.every((object) => object.storedAt >= newest));
                assert.deepEqual(await collectInventory(provider, targetId, store, newest + 1), []);
              }),
          );
        }),
    },
    {
      name: 'audit: pagination, append ordering, lifecycle rows, and prune reason',
      run: () =>
        withHarness(makeProvider, async (harness) => {
          const { provider } = harness;
          const caps = await provider.capabilities();
          if (!caps.capabilities.includes('audit')) return;
          assert.ok(provider.listEvents, 'audit method must be present');
          const { targetId } = await provider.createTarget({ label: 'audit' });
          if (caps.capabilities.includes('policy')) await provider.putPolicy!(targetId, POLICY);
          await provider.deleteTarget(targetId);
          await provider.undeleteTarget(targetId);
          await harness.seedPruneEvent?.(targetId);

          const events = await collectEvents(provider, targetId);
          for (let index = 1; index < events.length; index++) {
            assert.ok(events[index]!.at >= events[index - 1]!.at, 'events must be oldest-first');
          }
          assert.ok(events.some((event) => event.kind === 'soft-delete'));
          assert.ok(events.some((event) => event.kind === 'undelete'));
          if (caps.capabilities.includes('policy')) {
            assert.ok(events.some((event) => event.kind === 'policy-changed'));
          }
          for (const event of events.filter((row) => row.kind === 'prune')) {
            assert.equal(typeof event.detail.retentionRung, 'string');
            assert.ok(Array.isArray(event.detail.keys) && event.detail.keys.length > 0);
          }
          if (harness.seedPruneEvent) {
            assert.ok(events.some((event) => event.kind === 'prune'));
          }
          const newest = Math.max(...events.map((event) => event.at));
          assert.deepEqual(await collectEvents(provider, targetId, newest + 1), []);
        }),
    },
  ];
}
