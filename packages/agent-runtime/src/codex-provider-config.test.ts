import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { codexProviderOverrideArgs } from './codex-provider-config.ts';

test('codexProviderOverrideArgs emits -c overrides for provider + endpoint', () => {
  const args = codexProviderOverrideArgs({
    id: 'centraid-mock',
    name: 'Centraid Automation Mock',
    baseUrl: 'http://127.0.0.1:51234/v1',
    envKey: 'CENTRAID_MOCK_KEY',
  });
  // Each override is a (`-c`, `key=value`) pair, so the array is even-length
  // and every even index is the `-c` flag.
  assert.equal(args.length % 2, 0);
  for (let i = 0; i < args.length; i += 2) assert.equal(args[i], '-c');
  const overrides = args.filter((_, i) => i % 2 === 1);
  assert.ok(overrides.includes('model_provider="centraid-mock"'));
  assert.ok(overrides.includes('model_providers.centraid-mock.name="Centraid Automation Mock"'));
  assert.ok(
    overrides.includes('model_providers.centraid-mock.base_url="http://127.0.0.1:51234/v1"'),
  );
  // wire_api defaults to responses — the only format codex 0.128+ accepts.
  assert.ok(overrides.includes('model_providers.centraid-mock.wire_api="responses"'));
  assert.ok(overrides.includes('model_providers.centraid-mock.env_key="CENTRAID_MOCK_KEY"'));
});

test('codexProviderOverrideArgs omits env_key for keyless providers', () => {
  const args = codexProviderOverrideArgs({
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
  });
  assert.equal(
    args.some((a) => a.includes('env_key')),
    false,
  );
});

test('codexProviderOverrideArgs never emits the API key', () => {
  // The key flows via env under env_key; it is never an arg.
  const args = codexProviderOverrideArgs({
    id: 'p',
    name: 'P',
    baseUrl: 'http://localhost/v1',
    envKey: 'P_KEY',
    apiKey: 'sk-secret-should-not-appear',
  });
  assert.equal(
    args.some((a) => a.includes('sk-secret')),
    false,
  );
});
