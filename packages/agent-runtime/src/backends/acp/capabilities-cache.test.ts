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
  expect(caps.configOptions.map((option) => option.category)).toEqual(['model', 'thought_level']);
  expect(caps.usageUpdateObserved).toBe(true);
  expect(caps.configOptionUpdateObserved).toBe(true);
  expect(caps.locationsObserved).toBe(true);
  expect(caps.authRequired).toBe(false);
});

test.each([
  {
    name: 'config-option-less',
    args: ['--mode=normal', '--no-model-option', '--no-effort-option'],
    expected: { model: false, effort: false, usage: true, configUpdate: false, locations: true },
  },
  {
    name: 'model only',
    args: ['--mode=normal', '--no-effort-option'],
    expected: { model: true, effort: false, usage: true, configUpdate: true, locations: true },
  },
  {
    name: 'effort without model',
    args: ['--mode=normal', '--no-model-option'],
    expected: { model: false, effort: true, usage: true, configUpdate: false, locations: true },
  },
  {
    name: 'no optional observations',
    args: ['--mode=normal', '--no-usage-update', '--no-config-update', '--no-locations'],
    expected: { model: true, effort: true, usage: false, configUpdate: false, locations: false },
  },
])('capability matrix: $name', async ({ args, expected }) => {
  const caps = await probeAcpCapabilities(
    { kind: 'acp', acpArgs: [], binPath: FAKE_AGENT, extraArgs: args },
    { timeoutMs: 8_000 },
  );
  expect(caps.reachable).toBe(true);
  expect(caps.modelConfigurable).toBe(expected.model);
  expect(caps.configOptions.some((option) => option.category === 'thought_level')).toBe(
    expected.effort,
  );
  expect(caps.usageUpdateObserved).toBe(expected.usage);
  expect(caps.configOptionUpdateObserved).toBe(expected.configUpdate);
  expect(caps.locationsObserved).toBe(expected.locations);
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

test('probeAcpCapabilities sets authRequired when the diagnostic prompt rejects auth', async () => {
  const caps = await probeAcpCapabilities(
    {
      kind: 'acp',
      acpArgs: [],
      binPath: FAKE_AGENT,
      extraArgs: ['--mode=auth-prompt'],
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

test('cache and probe include the configured extraArgs launch profile', async () => {
  const withoutModel = await resolveAcpCapabilities('acp', {
    binPath: FAKE_AGENT,
    extraArgs: ['--mode=normal', '--no-model-option'],
    refresh: true,
  });
  expect(withoutModel?.modelConfigurable).toBe(false);

  // A different profile must not collide with the first profile's cache.
  expect(
    await resolveAcpCapabilities('acp', {
      binPath: FAKE_AGENT,
      extraArgs: ['--mode=normal'],
    }),
  ).toBeUndefined();
  const withModel = await resolveAcpCapabilities('acp', {
    binPath: FAKE_AGENT,
    extraArgs: ['--mode=normal'],
    refresh: true,
  });
  expect(withModel?.modelConfigurable).toBe(true);
});
