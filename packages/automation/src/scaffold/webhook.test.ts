import { tempDir } from '@centraid/test-kit/temp-dir';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateWebhookId,
  generateWebhookSecret,
  hashWebhookSecret,
  makeWebhookRouteHandler,
  provisionPendingWebhooksInFiles,
  rotateWebhookInFiles,
  verifyWebhookSecret,
  WEBHOOK_ROUTE_PREFIX,
  type WebhookFileMapEntry,
} from './webhook.js';

function manifest(triggers: unknown[]): string {
  return (
    JSON.stringify(
      {
        name: 'Hook',
        version: '0.1.0',
        enabled: true,
        prompt: 'do the thing',
        triggers,
        requires: {},
        history: { keep: { count: 100 } },
        generated: { by: 'centraid-builder', at: '2026-01-01T00:00:00.000Z' },
      },
      null,
      2,
    ) + '\n'
  );
}

describe('provisionPendingWebhooksInFiles', () => {
  it('mints id + secret for a pending webhook and rewrites the trigger', () => {
    const files: WebhookFileMapEntry[] = [
      { path: 'app.json', content: '{}' },
      {
        path: 'automations/hook/automation.json',
        content: manifest([{ kind: 'webhook', pending: true }]),
      },
      { path: 'automations/hook/handler.js', content: 'export default async () => ({});' },
    ];
    const { files: out, minted } = provisionPendingWebhooksInFiles(files, 'auto.hook');
    expect(minted.length).toBe(1);
    expect(minted[0]!.ownerApp).toBe('auto.hook');
    expect(minted[0]!.automationId).toBe('hook');
    expect(minted[0]!.secret).toMatch(/^[0-9a-f]{48}$/);

    const mf = JSON.parse(
      out.find((f) => f.path === 'automations/hook/automation.json')!.content,
    ) as { triggers: { kind: string; id: string; secretHash: string; pending?: boolean }[] };
    expect(mf.triggers[0]!.kind).toBe('webhook');
    expect(mf.triggers[0]!.id).toBe(minted[0]!.webhookId);
    expect(mf.triggers[0]!.pending).toBe(undefined);
    // The manifest stores only the hash; the plaintext verifies against it.
    expect(verifyWebhookSecret(minted[0]!.secret, mf.triggers[0]!.secretHash)).toBeTruthy();
    // Non-manifest files pass through untouched.
    expect(out.find((f) => f.path === 'app.json')!.content).toBe('{}');
  });

  it('is a no-op when there is no pending webhook', () => {
    const files: WebhookFileMapEntry[] = [
      {
        path: 'automations/cron/automation.json',
        content: manifest([{ kind: 'cron', expr: '0 9 * * *' }]),
      },
    ];
    const { files: out, minted } = provisionPendingWebhooksInFiles(files, 'a');
    expect(minted).toEqual([]);
    expect(out[0]!.content).toBe(files[0]!.content);
  });

  it('passes through an unparseable manifest', () => {
    const files: WebhookFileMapEntry[] = [
      { path: 'automations/bad/automation.json', content: '{ not json' },
    ];
    const { minted, files: out } = provisionPendingWebhooksInFiles(files, 'a');
    expect(minted).toEqual([]);
    expect(out[0]!.content).toBe('{ not json');
  });
});

describe('rotateWebhookInFiles', () => {
  it('mints a fresh secret over the SAME webhook id and rewrites only the hash', () => {
    const files: WebhookFileMapEntry[] = [
      { path: 'app.json', content: '{}' },
      {
        path: 'automations/hook/automation.json',
        content: manifest([{ kind: 'webhook', id: 'abc123', secretHash: 'stale-hash' }]),
      },
      { path: 'automations/hook/handler.js', content: 'export default async () => ({});' },
    ];
    const { changed, rotated } = rotateWebhookInFiles(files, 'hook');
    expect(rotated).toBeTruthy();
    expect(rotated!.webhookId).toBe('abc123'); // unchanged — any configured caller URL survives.
    expect(rotated!.secret).toMatch(/^[0-9a-f]{48}$/);
    expect(changed.length).toBe(1);
    expect(changed[0]!.path).toBe('automations/hook/automation.json');

    const mf = JSON.parse(changed[0]!.content) as {
      triggers: { kind: string; id: string; secretHash: string }[];
    };
    expect(mf.triggers[0]!.id).toBe('abc123');
    expect(mf.triggers[0]!.secretHash).not.toBe('stale-hash');
    expect(verifyWebhookSecret(rotated!.secret, mf.triggers[0]!.secretHash)).toBeTruthy();
    // The old secret (whatever it was) no longer verifies against the new hash.
    expect(verifyWebhookSecret('whatever-the-old-plaintext-was', mf.triggers[0]!.secretHash)).toBe(
      false,
    );
  });

  it('is a no-op when the automation does not exist', () => {
    const files: WebhookFileMapEntry[] = [
      {
        path: 'automations/other/automation.json',
        content: manifest([{ kind: 'webhook', id: 'x', secretHash: 'h' }]),
      },
    ];
    const { changed, rotated } = rotateWebhookInFiles(files, 'missing');
    expect(changed).toEqual([]);
    expect(rotated).toBeUndefined();
  });

  it('is a no-op for an automation with no webhook trigger', () => {
    const files: WebhookFileMapEntry[] = [
      {
        path: 'automations/cron/automation.json',
        content: manifest([{ kind: 'cron', expr: '0 9 * * *' }]),
      },
    ];
    const { changed, rotated } = rotateWebhookInFiles(files, 'cron');
    expect(changed).toEqual([]);
    expect(rotated).toBeUndefined();
  });

  it('is a no-op for a still-pending (never minted) webhook trigger', () => {
    const files: WebhookFileMapEntry[] = [
      {
        path: 'automations/hook/automation.json',
        content: manifest([{ kind: 'webhook', pending: true }]),
      },
    ];
    const { changed, rotated } = rotateWebhookInFiles(files, 'hook');
    expect(changed).toEqual([]);
    expect(rotated).toBeUndefined();
  });

  it('passes through an unparseable manifest', () => {
    const files: WebhookFileMapEntry[] = [
      { path: 'automations/bad/automation.json', content: '{ not json' },
    ];
    const { changed, rotated } = rotateWebhookInFiles(files, 'bad');
    expect(changed).toEqual([]);
    expect(rotated).toBeUndefined();
  });
});

describe('webhook secret helpers', () => {
  it('mints id + secret and verifies only the matching plaintext', () => {
    const id = generateWebhookId();
    const secret = generateWebhookSecret();
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    const hash = hashWebhookSecret(secret);
    expect(verifyWebhookSecret(secret, hash)).toBe(true);
    expect(verifyWebhookSecret('wrong', hash)).toBe(false);
    // Length / empty-hash mismatches must fail closed without throwing.
    expect(verifyWebhookSecret(secret, '')).toBe(false);
    expect(verifyWebhookSecret(secret, 'ab')).toBe(false);
  });
});

describe('makeWebhookRouteHandler', () => {
  let appsDir: string;
  const secret = generateWebhookSecret();
  const webhookId = 'hookid1';
  const secretHash = hashWebhookSecret(secret);

  beforeEach(async () => {
    appsDir = await tempDir('centraid-webhook-route-');
    const dir = path.join(appsDir, 'auto.hook', 'automations', 'hook');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'automation.json'),
      JSON.stringify({
        name: 'Hook',
        version: '0.1.0',
        enabled: true,
        prompt: 'go',
        triggers: [{ kind: 'webhook', id: webhookId, secretHash }],
        requires: {},
        history: { keep: { count: 10 } },
        generated: { by: 'test', at: '2026-01-01T00:00:00.000Z' },
      }),
    );
    await fs.writeFile(path.join(dir, 'handler.js'), 'export default async () => ({});');
  });

  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  function mockReq(over: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  }): IncomingMessage {
    const body = over.body ?? '';
    const stream = Readable.from([typeof body === 'string' ? Buffer.from(body) : body]);
    return Object.assign(stream, {
      url: over.url ?? `${WEBHOOK_ROUTE_PREFIX}/${webhookId}`,
      method: over.method ?? 'POST',
      headers: over.headers ?? { authorization: `Bearer ${secret}` },
    }) as IncomingMessage;
  }

  function mockRes(): ServerResponse & { status?: number; bodyText?: string } {
    const res = {
      status: undefined as number | undefined,
      bodyText: undefined as string | undefined,
      headers: {} as Record<string, string>,
      writeHead(status: number, headers?: Record<string, string>) {
        res.status = status;
        if (headers) Object.assign(res.headers, headers);
        return res;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined && chunk !== null) {
          res.bodyText = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        }
        return res;
      },
    };
    return res as unknown as ServerResponse & { status?: number; bodyText?: string };
  }

  it('returns false for non-webhook URLs', async () => {
    const handler = makeWebhookRouteHandler({
      appsDir,
      fire: vi.fn(),
    });
    const res = mockRes();
    expect(await handler(mockReq({ url: '/other' }), res)).toBe(false);
  });

  it('rejects non-POST and unknown slugs', async () => {
    const handler = makeWebhookRouteHandler({ appsDir, fire: vi.fn() });
    const getRes = mockRes();
    expect(await handler(mockReq({ method: 'GET' }), getRes)).toBe(true);
    expect(getRes.status).toBe(405);

    const badRes = mockRes();
    expect(await handler(mockReq({ url: `${WEBHOOK_ROUTE_PREFIX}/!!!` }), badRes)).toBe(true);
    expect(badRes.status).toBe(404);
  });

  it('rejects missing secret, unknown id, and accepts a valid fire', async () => {
    const fire = vi.fn().mockResolvedValue({ ok: true, runId: 'r1' });
    const handler = makeWebhookRouteHandler({ appsDir, fire });

    const unauth = mockRes();
    expect(await handler(mockReq({ headers: {} }), unauth)).toBe(true);
    expect(unauth.status).toBe(401);

    const missing = mockRes();
    expect(await handler(mockReq({ url: `${WEBHOOK_ROUTE_PREFIX}/no-such-hook` }), missing)).toBe(
      true,
    );
    expect(missing.status).toBe(404);

    const okRes = mockRes();
    expect(
      await handler(
        mockReq({
          body: JSON.stringify({ hello: 1 }),
          headers: { authorization: `Bearer ${secret}` },
        }),
        okRes,
      ),
    ).toBe(true);
    expect(okRes.status).toBe(200);
    expect(fire).toHaveBeenCalledWith({
      automationRef: 'auto.hook/hook',
      body: { hello: 1 },
    });
    expect(JSON.parse(okRes.bodyText ?? '{}')).toMatchObject({ ok: true, runId: 'r1' });
  });

  it('accepts the x-openclaw-webhook-secret header and non-JSON bodies', async () => {
    const fire = vi.fn().mockResolvedValue({ ok: true });
    const handler = makeWebhookRouteHandler({ appsDir, fire });
    const res = mockRes();
    expect(
      await handler(
        mockReq({
          body: 'plain-text',
          headers: { 'x-openclaw-webhook-secret': secret },
        }),
        res,
      ),
    ).toBe(true);
    expect(res.status).toBe(200);
    expect(fire).toHaveBeenCalledWith({
      automationRef: 'auto.hook/hook',
      body: 'plain-text',
    });
  });

  it('skips disabled automations and reports fire failures', async () => {
    const dir = path.join(appsDir, 'auto.hook', 'automations', 'hook');
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'automation.json'), 'utf8')) as {
      enabled: boolean;
    };
    raw.enabled = false;
    await fs.writeFile(path.join(dir, 'automation.json'), JSON.stringify(raw));

    const handler = makeWebhookRouteHandler({
      appsDir,
      fire: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }),
    });
    const skipped = mockRes();
    expect(await handler(mockReq({}), skipped)).toBe(true);
    expect(skipped.status).toBe(200);
    expect(JSON.parse(skipped.bodyText ?? '{}')).toMatchObject({ skipped: 'automation disabled' });

    raw.enabled = true;
    await fs.writeFile(path.join(dir, 'automation.json'), JSON.stringify(raw));
    const failHandler = makeWebhookRouteHandler({
      appsDir,
      fire: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }),
    });
    const failed = mockRes();
    expect(await handler(mockReq({}), failed)).toBe(true);
    // Re-use failHandler for the actual fire path.
    const failed2 = mockRes();
    expect(await failHandler(mockReq({}), failed2)).toBe(true);
    expect(failed2.status).toBe(500);
  });

  it('returns 413 when the body exceeds the cap', async () => {
    const handler = makeWebhookRouteHandler({ appsDir, fire: vi.fn() });
    const huge = Buffer.alloc(65 * 1024, 0x61);
    const res = mockRes();
    expect(await handler(mockReq({ body: huge }), res)).toBe(true);
    expect(res.status).toBe(413);
  });
});
