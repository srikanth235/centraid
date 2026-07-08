/*
 * Unit tests for the vault-register tools wired into the OpenClaw embedded
 * turn (issue #319, WS3): session-scoped factory registration, in-process
 * dispatch through the gateway's owner-side runners, and receipt stripping.
 */

import { describe, expect, it } from 'vitest';
import type { AnyAgentTool, OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import type { VaultRegistry } from '@centraid/gateway';
import { isCentraidConversationSession, registerVaultTools } from './vault-tools.js';

type ToolFactory = (ctx: { sessionKey?: string }) => AnyAgentTool[] | null;

/** Capture the factory `registerVaultTools` hands to `api.registerTool`. */
function captureFactory(registry: VaultRegistry): ToolFactory {
  let factory: ToolFactory | undefined;
  const api = {
    registerTool: (t: unknown) => {
      factory = t as ToolFactory;
    },
  } as unknown as OpenClawPluginApi;
  registerVaultTools(api, Promise.resolve(registry));
  if (!factory) throw new Error('registerTool was not called');
  return factory;
}

function fakeRegistry(): VaultRegistry {
  const plane = {
    sqlAsOwner: (sql: string) => ({ receiptId: 'r1', rows: [{ q: sql }], cols: ['q'] }),
    invokeAsAssistant: (req: { command: string; input: Record<string, unknown> }) => ({
      status: 'parked',
      echo: req,
    }),
    contentAsOwner: async (call: { contentId: string }) => ({
      receiptId: 'r2',
      text: `body:${call.contentId}`,
      truncated: false,
    }),
  };
  return { current: () => plane } as unknown as VaultRegistry;
}

function toolByName(tools: AnyAgentTool[], name: string): AnyAgentTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

async function runTool(tool: AnyAgentTool, params: unknown): Promise<unknown> {
  const res = await tool.execute('call-1', params);
  const text = res.content.find((c) => c.type === 'text');
  return JSON.parse((text as { text: string }).text);
}

describe('isCentraidConversationSession', () => {
  it('accepts the prefixed conversation session key', () => {
    expect(isCentraidConversationSession('agent:main:centraid-conversation:todos:w1')).toBe(true);
  });
  it('rejects a foreign or missing session key', () => {
    expect(isCentraidConversationSession('agent:main:whatsapp:+123')).toBe(false);
    expect(isCentraidConversationSession(undefined)).toBe(false);
  });
});

describe('registerVaultTools', () => {
  it('returns the three vault tools only for centraid conversation sessions', () => {
    const factory = captureFactory(fakeRegistry());
    const inCentraid = factory({ sessionKey: 'agent:main:centraid-conversation:todos:w1' });
    expect(inCentraid?.map((t) => t.name).sort()).toEqual([
      'vault_content',
      'vault_invoke',
      'vault_sql',
    ]);
    expect(factory({ sessionKey: 'agent:main:telegram:1' })).toBeNull();
    expect(factory({})).toBeNull();
  });

  it('vault_sql dispatches to sqlAsOwner and strips the receipt id', async () => {
    const factory = captureFactory(fakeRegistry());
    const tools = factory({ sessionKey: 'centraid-conversation:todos:w1' })!;
    const out = (await runTool(toolByName(tools, 'vault_sql'), {
      sql: 'SELECT 1',
    })) as Record<string, unknown>;
    expect(out).toEqual({ rows: [{ q: 'SELECT 1' }], cols: ['q'] });
    expect(out).not.toHaveProperty('receiptId');
  });

  it('vault_invoke forwards command + input and returns the outcome', async () => {
    const factory = captureFactory(fakeRegistry());
    const tools = factory({ sessionKey: 'centraid-conversation:todos:w1' })!;
    const out = (await runTool(toolByName(tools, 'vault_invoke'), {
      command: 'schedule.propose_event',
      input: { title: 'Lunch' },
    })) as { status: string; echo: { command: string; input: Record<string, unknown> } };
    expect(out.status).toBe('parked');
    expect(out.echo).toMatchObject({
      command: 'schedule.propose_event',
      input: { title: 'Lunch' },
      // The runner stamps the assistant purpose for consent bookkeeping.
      purpose: 'dpv:ServiceProvision',
    });
  });

  it('vault_content resolves document text and strips the receipt id', async () => {
    const factory = captureFactory(fakeRegistry());
    const tools = factory({ sessionKey: 'centraid-conversation:todos:w1' })!;
    const out = (await runTool(toolByName(tools, 'vault_content'), {
      content_id: 'doc-9',
    })) as Record<string, unknown>;
    expect(out).toEqual({ text: 'body:doc-9', truncated: false });
    expect(out).not.toHaveProperty('receiptId');
  });

  it('rejects malformed tool input before dispatch', async () => {
    const factory = captureFactory(fakeRegistry());
    const tools = factory({ sessionKey: 'centraid-conversation:todos:w1' })!;
    await expect(toolByName(tools, 'vault_sql').execute('c', {})).rejects.toThrow(/vault_sql/);
    await expect(toolByName(tools, 'vault_invoke').execute('c', {})).rejects.toThrow(
      /vault_invoke/,
    );
    await expect(toolByName(tools, 'vault_content').execute('c', {})).rejects.toThrow(
      /vault_content/,
    );
  });
});
