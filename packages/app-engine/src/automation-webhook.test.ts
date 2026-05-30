import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  provisionPendingWebhooksInFiles,
  verifyWebhookSecret,
  type WebhookFileMapEntry,
} from './automation-webhook.js';

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
    assert.equal(minted.length, 1);
    assert.equal(minted[0]!.ownerApp, 'auto.hook');
    assert.equal(minted[0]!.automationId, 'hook');
    assert.match(minted[0]!.secret, /^[0-9a-f]{48}$/);

    const mf = JSON.parse(
      out.find((f) => f.path === 'automations/hook/automation.json')!.content,
    ) as { triggers: { kind: string; id: string; secretHash: string; pending?: boolean }[] };
    assert.equal(mf.triggers[0]!.kind, 'webhook');
    assert.equal(mf.triggers[0]!.id, minted[0]!.webhookId);
    assert.equal(mf.triggers[0]!.pending, undefined);
    // The manifest stores only the hash; the plaintext verifies against it.
    assert.ok(verifyWebhookSecret(minted[0]!.secret, mf.triggers[0]!.secretHash));
    // Non-manifest files pass through untouched.
    assert.equal(out.find((f) => f.path === 'app.json')!.content, '{}');
  });

  it('is a no-op when there is no pending webhook', () => {
    const files: WebhookFileMapEntry[] = [
      {
        path: 'automations/cron/automation.json',
        content: manifest([{ kind: 'cron', expr: '0 9 * * *' }]),
      },
    ];
    const { files: out, minted } = provisionPendingWebhooksInFiles(files, 'a');
    assert.deepEqual(minted, []);
    assert.equal(out[0]!.content, files[0]!.content);
  });

  it('passes through an unparseable manifest', () => {
    const files: WebhookFileMapEntry[] = [
      { path: 'automations/bad/automation.json', content: '{ not json' },
    ];
    const { minted, files: out } = provisionPendingWebhooksInFiles(files, 'a');
    assert.deepEqual(minted, []);
    assert.equal(out[0]!.content, '{ not json');
  });
});
