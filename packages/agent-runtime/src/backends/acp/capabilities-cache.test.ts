// Cache + probe path for Settings capability status. Uses the real fake ACP
// agent so the shipped resolve/probe entry points run end-to-end.

import { expect, test, afterEach } from 'vitest';
import { FAKE_AGENT } from './test-fixtures.js';
import { clearCapabilitiesCache, resolveAcpCapabilities } from './capabilities-cache.ts';
import { probeAcpCapabilities } from './probe-capabilities.ts';

afterEach(() => {
  clearCapabilitiesCache();
});

test('probeAcpCapabilities reports reachable + advertised caps from fake agent', async () => {
  const caps = await probeAcpCapabilities(
    {
      kind: 'acp',
      acpArgs: [],
      binPath: FAKE_AGENT,
      extraArgs: [
        '--mode=normal',
        '--session-resume',
        '--session-close',
        '--session-addl-dirs',
        '--mcp-http',
        '--prompt-caps=image,audio,embeddedContext',
      ],
    },
    { timeoutMs: 8_000 },
  );
  expect(caps.reachable).toBe(true);
  expect(caps.resume).toBe(true);
  expect(caps.close).toBe(true);
  expect(caps.additionalDirectories).toBe(true);
  expect(caps.mcpHttp).toBe(true);
  expect(caps.promptImage).toBe(true);
  expect(caps.promptAudio).toBe(true);
  expect(caps.promptEmbeddedContext).toBe(true);
  expect(caps.modelConfigurable).toBe(true);
  expect(caps.authRequired).toBe(false);
});

test('probeAcpCapabilities sets authRequired when session/new rejects auth', async () => {
  const caps = await probeAcpCapabilities(
    {
      kind: 'acp',
      acpArgs: [],
      binPath: FAKE_AGENT,
      extraArgs: ['--mode=auth'],
    },
    { timeoutMs: 8_000 },
  );
  expect(caps.reachable).toBe(true);
  expect(caps.authRequired).toBe(true);
});

test('probeAcpCapabilities returns reason when binary cannot launch', async () => {
  const caps = await probeAcpCapabilities({
    kind: 'acp',
    acpArgs: [],
    // No binPath / defaultBin → planLaunch throws.
  });
  expect(caps.reachable).toBe(false);
  expect(caps.reason).toMatch(/binary/i);
});

test('resolveAcpCapabilities does not probe without refresh', async () => {
  const cold = await resolveAcpCapabilities('acp', { binPath: FAKE_AGENT });
  expect(cold).toBeUndefined();
});

test('resolveAcpCapabilities caches a refresh probe and serves it cold', async () => {
  const first = await resolveAcpCapabilities('acp', {
    binPath: FAKE_AGENT,
    refresh: true,
  });
  expect(first?.reachable).toBe(true);

  const cached = await resolveAcpCapabilities('acp', { binPath: FAKE_AGENT });
  expect(cached).toEqual(first);
});

test('resolveAcpCapabilities coalesces concurrent refresh probes', async () => {
  const [a, b] = await Promise.all([
    resolveAcpCapabilities('acp', { binPath: FAKE_AGENT, refresh: true }),
    resolveAcpCapabilities('acp', { binPath: FAKE_AGENT, refresh: true }),
  ]);
  expect(a).toEqual(b);
  expect(a?.reachable).toBe(true);
});
