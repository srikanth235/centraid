import { tempDir } from '@centraid/test-kit/temp-dir';
// The import routes (issue #290 phase 2) over a real vault plane: stage a
// file over HTTP, review its rows, publish, and see the batch in history.

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { openVaultPlane, type VaultPlane } from '../serve/vault-plane.js';
import { makeImportRouteHandler } from './import-routes.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(): Promise<{ base: string; plane: VaultPlane }> {
  const dir = await tempDir(`import-routes-${crypto.randomUUID()}-`);
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const plane = openVaultPlane({ dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => plane.stop());
  const handler = makeImportRouteHandler({ current: () => plane });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  return { base: `http://127.0.0.1:${address.port}/centraid/_vault/imports`, plane };
}

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:evt-9@example.com',
  'SUMMARY:Housewarming',
  'DTSTART:20260710T160000Z',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('stage over HTTP → review rows → publish → history', async () => {
  const { base, plane } = await fixture();

  const staged = (await (
    await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'party.ics', text: ICS }),
    })
  ).json()) as { batchId: string; kind: string; staged: { create: number } };
  expect(staged.kind).toBe('file.ics');
  expect(staged.staged.create).toBe(1);

  const review = (await (await fetch(`${base}/${staged.batchId}`)).json()) as {
    rows: { disposition: string; entityType: string }[];
  };
  expect(review.rows).toEqual([
    expect.objectContaining({ disposition: 'create', entityType: 'core.event' }),
  ]);

  const published = (await (
    await fetch(`${base}/${staged.batchId}/publish`, { method: 'POST' })
  ).json()) as { created: number };
  expect(published.created).toBe(1);
  const event = plane.db.vault
    .prepare('SELECT summary FROM core_event WHERE ical_uid = ?')
    .get('evt-9@example.com') as { summary: string };
  expect(event.summary).toBe('Housewarming');

  const listed = (await (await fetch(base)).json()) as {
    batches: { status: string; label: string }[];
  };
  expect(listed.batches[0]).toMatchObject({ status: 'published', label: 'party.ics' });
});

test('an unroutable file is a clean 400, not a hang', async () => {
  const { base } = await fixture();
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'photo.heic', text: 'not really' }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toMatch(/no importer/);
});
