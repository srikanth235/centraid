import { describe, expect, it } from 'vitest';
import {
  provisionPendingWebhooksInFiles,
  verifyWebhookSecret,
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
