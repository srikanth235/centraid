import { tempDir } from '@centraid/test-kit/temp-dir';
// governance: allow-repo-hygiene file-size-limit (#419) one route suite shares the real vault-plane fixture across bootstrap, windowed pagination, delta, SSE, row, checkpoint, and intent surfaces
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { currentReplicaLogState, recordReplicaIntentOutcome } from '@centraid/vault';
import { afterEach, expect, test, vi } from 'vitest';
import { EnrollmentStore } from '../serve/enrollment-store.js';
import { openVaultPlane, type VaultPlane } from '../serve/vault-plane.js';
import { runWithVaultContext } from '../serve/vault-context.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { makeReplicaRouteHandler } from './replica-routes.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(
  options: { maxBootstrapRows?: number; maxSyntheticLookupRows?: number } = {},
): Promise<{
  plane: VaultPlane;
  enrollments: EnrollmentStore;
  handler: ReturnType<typeof makeReplicaRouteHandler>;
}> {
  const dir = await tempDir(`replica-routes-${crypto.randomUUID()}-`);
  const plane = openVaultPlane({ dir, logger, enableWalShipper: false });
  const enrollments = EnrollmentStore.open(path.join(dir, 'devices.json'));
  const vaults = { current: () => plane } as unknown as VaultRegistry;
  const handler = makeReplicaRouteHandler(vaults, {
    enrollments,
    dispatchIntent: vi.fn().mockResolvedValue({ status: 'executed' }),
    pollIntervalMs: 1,
    heartbeatMs: 5,
    ...options,
  });
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  cleanups.push(() => plane.stop());
  plane.approveGrant('agenda', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', table: 'task', verbs: 'read+act' }],
  });
  return { plane, enrollments, handler };
}

function task(plane: VaultPlane, id: string, title: string): void {
  plane.db.vault
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, status, priority)
       VALUES (?, ?, ?, 'needs-action', 0)`,
    )
    .run(id, plane.boot.ownerPartyId, title);
}

function request(
  url: string,
  init: { method?: string; body?: unknown; accept?: string } = {},
): IncomingMessage {
  const req = Readable.from(init.body === undefined ? [] : [JSON.stringify(init.body)]);
  return Object.assign(req, {
    url,
    method: init.method ?? 'GET',
    headers: init.accept ? { accept: init.accept } : {},
  }) as unknown as IncomingMessage;
}

class MockResponse extends EventTarget {
  statusCode = 200;
  readonly headers = new Map<string, string>();
  body = '';
  onWrite?: (chunk: string) => void;

  on(type: string, listener: () => void): this {
    this.addEventListener(type, listener);
    return this;
  }

  off(type: string, listener: () => void): this {
    this.removeEventListener(type, listener);
    return this;
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
    return this;
  }

  flushHeaders(): void {}

  write(value: string | Buffer): boolean {
    const chunk = String(value);
    this.body += chunk;
    this.onWrite?.(chunk);
    return true;
  }

  end(value?: string | Buffer): this {
    if (value !== undefined) this.body += String(value);
    return this;
  }

  json<T>(): T {
    return JSON.parse(this.body) as T;
  }
}

test('bootstrap at N, filtered pull, checkpoint, and the single resumable SSE tail agree', async () => {
  const { plane, enrollments, handler } = await fixture();
  const deviceKey = 'device-1';
  enrollments.enroll({
    endpointId: deviceKey,
    vaultId: plane.boot.vaultId,
    label: 'Offline browser',
    rememberDevice: true,
  });
  task(plane, 'task-1', 'Already present');

  const bootstrapRes = new MockResponse();
  await runWithVaultContext({ vaultId: plane.boot.vaultId, deviceKey }, () =>
    handler(
      request('/centraid/_vault/replica/bootstrap'),
      bootstrapRes as unknown as ServerResponse,
    ),
  );
  expect(bootstrapRes.statusCode).toBe(200);
  const bootstrap = bootstrapRes.json<{
    cursor: { epoch: string; seq: number };
    schemaEpoch: string;
    shapes: Array<{ appId: string; entities: Array<{ entity: string }> }>;
    rows: Array<{ entity: string; rowId: string; values: Record<string, unknown> }>;
  }>();
  expect(bootstrap.shapes).toEqual([
    expect.objectContaining({
      appId: 'agenda',
      entities: [expect.objectContaining({ entity: 'schedule.task' })],
    }),
  ]);
  expect(bootstrap.rows).toContainEqual(
    expect.objectContaining({
      entity: 'schedule.task',
      rowId: 'task-1',
      values: expect.objectContaining({ title: 'Already present' }),
    }),
  );
  // Merely receiving a snapshot is not an acknowledgement; the client stamps
  // its checkpoint only after the local SQLite bootstrap commits.
  expect(enrollments.get(deviceKey, plane.boot.vaultId)?.checkpoint).toBeUndefined();

  task(plane, 'task-2', 'Arrived after bootstrap');
  const since = encodeURIComponent(`${bootstrap.cursor.epoch}:${bootstrap.cursor.seq}`);
  const changesRes = new MockResponse();
  await runWithVaultContext({ vaultId: plane.boot.vaultId, deviceKey }, () =>
    handler(
      request(`/centraid/_vault/changes?since=${since}`),
      changesRes as unknown as ServerResponse,
    ),
  );
  const changes = changesRes.json<{
    from: { epoch: string; seq: number };
    to: { epoch: string; seq: number };
    changes: Array<{ op: string; entity: string; rowId: string; values: Record<string, unknown> }>;
  }>();
  expect(changes.from).toEqual(bootstrap.cursor);
  expect(changes.to.seq).toBeGreaterThan(bootstrap.cursor.seq);
  expect(changes.changes).toContainEqual(
    expect.objectContaining({
      op: 'upsert',
      entity: 'schedule.task',
      rowId: 'task-2',
      values: expect.objectContaining({ title: 'Arrived after bootstrap' }),
    }),
  );

  const checkpointRes = new MockResponse();
  await runWithVaultContext({ vaultId: plane.boot.vaultId, deviceKey }, () =>
    handler(
      request('/centraid/_vault/replica/checkpoint', {
        method: 'POST',
        body: { cursor: changes.to, schemaEpoch: bootstrap.schemaEpoch },
      }),
      checkpointRes as unknown as ServerResponse,
    ),
  );
  expect(checkpointRes.json<{ persisted: boolean }>().persisted).toBe(true);
  expect(enrollments.get(deviceKey, plane.boot.vaultId)?.checkpoint?.seq).toBe(changes.to.seq);

  task(plane, 'task-3', 'SSE doorbell');
  const sseReq = request(
    `/centraid/_vault/changes?since=${encodeURIComponent(`${changes.to.epoch}:${changes.to.seq}`)}&stream=1`,
    { accept: 'text/event-stream' },
  );
  const sseRes = new MockResponse();
  sseRes.onWrite = (chunk) => {
    if (chunk.includes('event: cursor')) sseReq.emit('close');
  };
  await runWithVaultContext({ vaultId: plane.boot.vaultId, deviceKey }, () =>
    handler(sseReq, sseRes as unknown as ServerResponse),
  );
  expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
  expect(sseRes.body).toContain('event: change');
  expect(sseRes.body).toContain('"rowId":"task-3"');
  expect(sseRes.body).toContain('event: cursor');
});

type WindowPage = {
  cursor: { epoch: string; seq: number };
  rows: Array<{ entity: string; rowId: string; values: Record<string, unknown> }>;
  complete: boolean;
  next?: string;
  shapes?: unknown;
};

async function bootstrapPage(
  handler: ReturnType<typeof makeReplicaRouteHandler>,
  vaultId: string,
  deviceKey: string,
  query: string,
): Promise<{ status: number; page: WindowPage }> {
  const res = new MockResponse();
  await runWithVaultContext({ vaultId, deviceKey }, () =>
    handler(
      request(`/centraid/_vault/replica/bootstrap${query}`),
      res as unknown as ServerResponse,
    ),
  );
  return { status: res.statusCode, page: res.json<WindowPage>() };
}

test('windowed bootstrap pages through every row, shapes only on page 1, then converges', async () => {
  const { plane, enrollments, handler } = await fixture();
  const deviceKey = 'device-window';
  enrollments.enroll({
    endpointId: deviceKey,
    vaultId: plane.boot.vaultId,
    label: 'Offline browser',
    rememberDevice: true,
  });
  const ids = ['task-01', 'task-02', 'task-03', 'task-04', 'task-05'];
  for (const id of ids) task(plane, id, `Title ${id}`);

  // Page 1 carries the full envelope + the first window + a continuation token.
  const first = await bootstrapPage(handler, plane.boot.vaultId, deviceKey, '?window=2');
  expect(first.status).toBe(200);
  expect(first.page.shapes).toBeDefined();
  expect(first.page.complete).toBe(false);
  expect(first.page.next).toBeTruthy();
  expect(first.page.rows).toHaveLength(2);

  // Follow the continuation until complete; each page after the first is lean.
  const collected = [...first.page.rows];
  let next = first.page.next;
  const cursors = [first.page.cursor];
  let guard = 0;
  while (next && guard < 10) {
    guard += 1;
    const page = await bootstrapPage(
      handler,
      plane.boot.vaultId,
      deviceKey,
      `?window=2&after=${encodeURIComponent(next)}`,
    );
    expect(page.status).toBe(200);
    expect(page.page.shapes).toBeUndefined(); // continuation pages omit shapes
    cursors.push(page.page.cursor);
    collected.push(...page.page.rows);
    next = page.page.complete ? undefined : page.page.next;
    if (page.page.complete) break;
  }
  // Every task arrived exactly once across the windows.
  const seen = collected
    .filter((row) => row.entity === 'schedule.task')
    .map((row) => row.rowId)
    .sort();
  expect(seen).toEqual(ids);
  // The delta floor the client replays from is page 1's cursor (the minimum).
  expect(cursors[0]!.seq).toBe(Math.min(...cursors.map((c) => c.seq)));
});

async function bootstrapDirect(
  handler: ReturnType<typeof makeReplicaRouteHandler>,
  query: string,
): Promise<{ status: number; page: WindowPage & { error?: string; reason?: string } }> {
  const res = new MockResponse();
  await handler(
    request(`/centraid/_vault/replica/bootstrap${query}`),
    res as unknown as ServerResponse,
  );
  return { status: res.statusCode, page: res.json() };
}

test('windowed bootstrap rejects a bad window and a tampered continuation token', async () => {
  const { plane, handler } = await fixture();
  task(plane, 'task-1', 'One');
  const bad = await bootstrapDirect(handler, '?window=0');
  expect(bad.status).toBe(400);
  expect(bad.page).toMatchObject({ error: 'invalid_replica_window' });

  const tampered = await bootstrapDirect(handler, '?window=2&after=not-a-valid-token');
  expect(tampered.status).toBe(400);
  expect(tampered.page).toMatchObject({ error: 'invalid_replica_bootstrap_token' });
});

test('a schemaEpoch change between windows forces a 409 rebootstrap', async () => {
  const { plane, handler } = await fixture();
  for (const id of ['task-01', 'task-02', 'task-03']) task(plane, id, id);
  const first = await bootstrapDirect(handler, '?window=1');
  expect(first.page.next).toBeTruthy();
  // Forge a continuation whose pinned schemaEpoch no longer matches the vault.
  const decoded = JSON.parse(Buffer.from(first.page.next!, 'base64url').toString('utf8'));
  decoded.schemaEpoch += 1;
  const forged = Buffer.from(JSON.stringify(decoded)).toString('base64url');
  const conflicted = await bootstrapDirect(
    handler,
    `?window=1&after=${encodeURIComponent(forged)}`,
  );
  expect(conflicted.status).toBe(409);
  expect(conflicted.page).toMatchObject({
    error: 'replica_rebootstrap_required',
    reason: 'epoch-changed',
  });
});

test('revoking the grant between windows forces a shape-changed 409', async () => {
  const { plane, handler } = await fixture();
  for (const id of ['task-01', 'task-02', 'task-03']) task(plane, id, id);
  const first = await bootstrapDirect(handler, '?window=1&appId=agenda');
  expect(first.page.next).toBeTruthy();
  const grant = plane.listApps().find((app) => app.name === 'agenda')?.grants[0];
  plane.revokeGrant(grant!.grantId);
  const conflicted = await bootstrapDirect(
    handler,
    `?window=1&appId=agenda&after=${encodeURIComponent(first.page.next!)}`,
  );
  expect(conflicted.status).toBe(409);
  expect(conflicted.page.reason).toBe('shape-changed');
});

test('windowed mode bypasses the maxBootstrapRows 413 cap', async () => {
  const { plane, handler } = await fixture({ maxBootstrapRows: 1 });
  for (const id of ['task-01', 'task-02', 'task-03']) task(plane, id, id);
  const res = new MockResponse();
  await handler(
    request('/centraid/_vault/replica/bootstrap?window=10000'),
    res as unknown as ServerResponse,
  );
  expect(res.statusCode).toBe(200);
  const page = res.json<WindowPage>();
  expect(page.complete).toBe(true);
  expect(page.next).toBeUndefined();
  expect(page.rows.filter((row) => row.entity === 'schedule.task')).toHaveLength(3);
});

test('the non-windowed bootstrap stays a single shot with no window fields', async () => {
  const { plane, handler } = await fixture();
  task(plane, 'task-1', 'One');
  const res = new MockResponse();
  await handler(request('/centraid/_vault/replica/bootstrap'), res as unknown as ServerResponse);
  const body = res.json<Record<string, unknown>>();
  expect(res.statusCode).toBe(200);
  expect(body.complete).toBeUndefined();
  expect(body.next).toBeUndefined();
  expect(body.shapes).toBeDefined();
});

test('the bootstrap sentinel explicitly requests rebootstrap instead of guessing an epoch', async () => {
  const { handler } = await fixture();
  const res = new MockResponse();
  await handler(request('/centraid/_vault/changes?since=0%3A0'), res as unknown as ServerResponse);
  expect(res.statusCode).toBe(409);
  expect(res.json<{ error: string; reason: string }>()).toMatchObject({
    error: 'replica_rebootstrap_required',
    reason: 'initial',
  });
});

test('invalid SSE limits are rejected before stream headers and never request a data wipe', async () => {
  const { handler } = await fixture();
  const res = new MockResponse();
  await handler(
    request('/centraid/_vault/changes?since=0%3A0&stream=1&limit=unbounded', {
      accept: 'text/event-stream',
    }),
    res as unknown as ServerResponse,
  );

  expect(res.statusCode).toBe(400);
  expect(res.headers.get('content-type')).toContain('application/json');
  expect(res.json()).toEqual({ error: 'invalid_replica_limit' });
  expect(res.body).not.toContain('rebootstrap');
});

test('bootstrap refuses a snapshot beyond its configured authenticated-work bound', async () => {
  const { plane, handler } = await fixture({ maxBootstrapRows: 1 });
  task(plane, 'bounded-a', 'First');
  task(plane, 'bounded-b', 'Second');
  const res = new MockResponse();

  await handler(request('/centraid/_vault/replica/bootstrap'), res as unknown as ServerResponse);

  expect(res.statusCode).toBe(413);
  expect(res.json()).toEqual({ error: 'replica_bootstrap_too_large' });
});

test('lazy fields resolve by opaque masked-PK row id without disclosing the canonical key', async () => {
  const { plane, handler } = await fixture();
  const initial = plane.listApps().find((app) => app.name === 'agenda')?.grants[0];
  expect(initial).toBeDefined();
  plane.revokeGrant(initial!.grantId);
  plane.approveGrant('agenda', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        fieldMask: ['title', 'description'],
      },
    ],
  });
  const description = 'd'.repeat(70_000);
  plane.db.vault
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, description, status, priority)
       VALUES ('lazy-canonical-secret', ?, 'Lazy', ?, 'needs-action', 0)`,
    )
    .run(plane.boot.ownerPartyId, description);

  const bootstrapRes = new MockResponse();
  await handler(
    request('/centraid/_vault/replica/bootstrap?appId=agenda'),
    bootstrapRes as unknown as ServerResponse,
  );
  const bootstrap = bootstrapRes.json<{
    shapes: Array<{ shapeId: string }>;
    rows: Array<{ entity: string; rowId: string; oversizedFields?: string[] }>;
  }>();
  const row = bootstrap.rows.find((candidate) => candidate.entity === 'schedule.task')!;
  expect(row.rowId).toMatch(/^r_/);
  expect(row.oversizedFields).toContain('description');
  expect(bootstrapRes.body).not.toContain('lazy-canonical-secret');

  const params = new URLSearchParams({
    appId: 'agenda',
    shapeId: bootstrap.shapes[0]!.shapeId,
    entity: 'schedule.task',
    rowId: row.rowId,
    column: 'description',
  });
  const lazyRes = new MockResponse();
  await handler(
    request(`/centraid/_vault/replica/row?${params}`),
    lazyRes as unknown as ServerResponse,
  );
  expect(lazyRes.statusCode).toBe(200);
  expect(lazyRes.json<{ row: { rowId: string; values: { description: string } } }>().row).toEqual({
    shapeId: bootstrap.shapes[0]!.shapeId,
    entity: 'schedule.task',
    rowId: row.rowId,
    values: { description },
  });
  expect(lazyRes.body).not.toContain('lazy-canonical-secret');
});

test('synthetic lazy-row lookup is bounded instead of scanning an unbounded entity', async () => {
  const { plane, handler } = await fixture({ maxSyntheticLookupRows: 1 });
  const initial = plane.listApps().find((app) => app.name === 'agenda')?.grants[0];
  plane.revokeGrant(initial!.grantId);
  plane.approveGrant('agenda', {
    purpose: 'dpv:ServiceProvision',
    scopes: [
      {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        fieldMask: ['title', 'description'],
      },
    ],
  });
  for (const id of ['a-canonical', 'z-canonical']) {
    plane.db.vault
      .prepare(
        `INSERT INTO schedule_task
           (task_id, owner_party_id, title, description, status, priority)
         VALUES (?, ?, ?, ?, 'needs-action', 0)`,
      )
      .run(id, plane.boot.ownerPartyId, id, 'd'.repeat(70_000));
  }
  const bootstrapRes = new MockResponse();
  await handler(
    request('/centraid/_vault/replica/bootstrap?appId=agenda'),
    bootstrapRes as unknown as ServerResponse,
  );
  const bootstrap = bootstrapRes.json<{
    shapes: Array<{ shapeId: string }>;
    rows: Array<{ rowId: string; values: { title: string } }>;
  }>();
  const target = bootstrap.rows.find((row) => row.values.title === 'z-canonical')!;
  const params = new URLSearchParams({
    appId: 'agenda',
    shapeId: bootstrap.shapes[0]!.shapeId,
    entity: 'schedule.task',
    rowId: target.rowId,
    column: 'description',
  });
  const res = new MockResponse();

  await handler(
    request(`/centraid/_vault/replica/row?${params}`),
    res as unknown as ServerResponse,
  );

  expect(res.statusCode).toBe(413);
  expect(res.json()).toEqual({ error: 'replica_row_lookup_too_large' });
});

test('reconciles only explicitly pending, device-scoped outcomes through the snapshot cursor', async () => {
  const { plane, enrollments, handler } = await fixture();
  const deviceKey = 'device-outcomes';
  enrollments.enroll({
    endpointId: deviceKey,
    vaultId: plane.boot.vaultId,
    label: 'Offline browser',
    rememberDevice: true,
  });
  recordReplicaIntentOutcome(plane.db.vault, {
    intentId: 'historical-pending',
    deviceId: deviceKey,
    appId: 'agenda',
    action: 'task.complete',
    payloadHash: 'a'.repeat(64),
    status: 'executed',
  });

  const bootstrapRes = new MockResponse();
  await runWithVaultContext({ vaultId: plane.boot.vaultId, deviceKey }, () =>
    handler(
      request('/centraid/_vault/replica/bootstrap'),
      bootstrapRes as unknown as ServerResponse,
    ),
  );
  const bootstrap = bootstrapRes.json<{ cursor: { epoch: string; seq: number } }>();
  const outcomesRes = new MockResponse();
  await runWithVaultContext({ vaultId: plane.boot.vaultId, deviceKey }, () =>
    handler(
      request('/centraid/_vault/replica/outcomes', {
        method: 'POST',
        body: { intentIds: ['historical-pending', 'unknown'], through: bootstrap.cursor },
      }),
      outcomesRes as unknown as ServerResponse,
    ),
  );

  expect(outcomesRes.statusCode).toBe(200);
  expect(outcomesRes.json<{ outcomes: unknown[] }>().outcomes).toEqual([
    { intentId: 'historical-pending', status: 'executed' },
  ]);
});

test('a stale persisted shape catalog forces pull conflict and stream rebootstrap', async () => {
  const { plane, handler } = await fixture();
  const bootstrapRes = new MockResponse();
  await handler(
    request('/centraid/_vault/replica/bootstrap'),
    bootstrapRes as unknown as ServerResponse,
  );
  const bootstrap = bootstrapRes.json<{
    cursor: { epoch: string; seq: number };
    shapeIds: string[];
  }>();
  expect(bootstrap.shapeIds).toHaveLength(1);

  const grant = plane.listApps().find((app) => app.name === 'agenda')?.grants[0];
  expect(grant).toBeDefined();
  plane.revokeGrant(grant!.grantId);
  const current = currentReplicaLogState(plane.db.vault).watermark;
  const query = new URLSearchParams({
    since: `${current.epoch}:${current.seq}`,
    shapeIds: bootstrap.shapeIds.join(','),
  });

  const pullRes = new MockResponse();
  await handler(request(`/centraid/_vault/changes?${query}`), pullRes as unknown as ServerResponse);
  expect(pullRes.statusCode).toBe(409);
  expect(pullRes.json<{ error: string; reason: string }>()).toMatchObject({
    error: 'replica_rebootstrap_required',
    reason: 'shape-changed',
  });

  query.set('stream', '1');
  const streamRes = new MockResponse();
  await handler(
    request(`/centraid/_vault/changes?${query}`, { accept: 'text/event-stream' }),
    streamRes as unknown as ServerResponse,
  );
  expect(streamRes.body).toContain('event: rebootstrap');
  expect(streamRes.body).toContain('"reason":"shape-changed"');
});
