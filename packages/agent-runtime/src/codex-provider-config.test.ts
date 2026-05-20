import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProviderToml, materializeCodexHome } from './codex-provider-config.ts';

test('buildProviderToml emits a model_provider line and a [model_providers.<id>] table', () => {
  const toml = buildProviderToml({
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
  });
  assert.match(toml, /model_provider = "groq"/);
  assert.match(toml, /\[model_providers\.groq\]/);
  assert.match(toml, /name = "Groq"/);
  assert.match(toml, /base_url = "https:\/\/api\.groq\.com\/openai\/v1"/);
  // codex 0.128+ rejects `wire_api = "chat"`; `responses` is the default.
  assert.match(toml, /wire_api = "responses"/);
  assert.match(toml, /env_key = "GROQ_API_KEY"/);
});

test('buildProviderToml respects an explicit wireApi=chat override', () => {
  const toml = buildProviderToml({
    id: 'legacy',
    name: 'Legacy',
    baseUrl: 'https://legacy.example.com/v1',
    wireApi: 'chat',
  });
  assert.match(toml, /wire_api = "chat"/);
});

test('buildProviderToml omits env_key for keyless providers', () => {
  const toml = buildProviderToml({
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
  });
  assert.doesNotMatch(toml, /env_key/);
});

test('buildProviderToml respects wireApi=responses', () => {
  const toml = buildProviderToml({
    id: 'together',
    name: 'Together',
    baseUrl: 'https://api.together.xyz/v1',
    wireApi: 'responses',
  });
  assert.match(toml, /wire_api = "responses"/);
});

test('buildProviderToml escapes special characters in string values', () => {
  const toml = buildProviderToml({
    id: 'safe-id',
    // Embedded backslash, quote, and newline should be escaped, never raw.
    name: 'Quirky "Name"\nNext line',
    baseUrl: 'https://example.com/v1',
  });
  assert.match(toml, /name = "Quirky \\"Name\\"\\nNext line"/);
});

test('buildProviderToml quotes a non-bare provider id in the table header', () => {
  const toml = buildProviderToml({
    id: 'my.weird/id',
    name: 'Weird',
    baseUrl: 'https://example.com/v1',
  });
  // bare-key regex rejects `.` and `/`, so the table header must be quoted.
  assert.match(toml, /\[model_providers\."my\.weird\/id"\]/);
  // The `model_provider` line still uses the raw id as a TOML string.
  assert.match(toml, /model_provider = "my\.weird\/id"/);
});

test('materializeCodexHome writes config.toml under <baseDir>/codex-homes/<id>', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-test-'));
  try {
    const home = await materializeCodexHome(
      {
        id: 'vllm-local',
        name: 'vLLM (local)',
        baseUrl: 'http://localhost:8000/v1',
        envKey: 'VLLM_API_KEY',
      },
      baseDir,
    );
    assert.equal(home, path.join(baseDir, 'codex-homes', 'vllm-local'));
    const written = await fs.readFile(path.join(home, 'config.toml'), 'utf8');
    assert.match(written, /model_provider = "vllm-local"/);
    assert.match(written, /\[model_providers\.vllm-local\]/);
    assert.match(written, /base_url = "http:\/\/localhost:8000\/v1"/);
    assert.match(written, /env_key = "VLLM_API_KEY"/);
    // Crucially, the toml MUST NOT contain the API key — that flows via env.
    assert.doesNotMatch(written, /sk-/);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('materializeCodexHome sanitizes ids with filesystem-unsafe chars', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-test-'));
  try {
    const home = await materializeCodexHome(
      {
        id: '../escape/attempt',
        name: 'malicious',
        baseUrl: 'http://localhost/v1',
      },
      baseDir,
    );
    // The materialized home must resolve *under* <baseDir>/codex-homes/.
    // We check the resolved path, not substrings — a leaf name like
    // `.._escape_attempt` is a literal directory, not a traversal.
    const codexHomes = path.resolve(baseDir, 'codex-homes');
    const resolved = path.resolve(home);
    assert.ok(
      resolved.startsWith(codexHomes + path.sep),
      `expected ${resolved} under ${codexHomes}`,
    );
    // And the leaf must be exactly one path segment (no slashes survived).
    const leaf = path.basename(resolved);
    assert.equal(leaf.includes('/'), false);
    assert.equal(leaf.includes(path.sep), false);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('materializeCodexHome rewrites toml on every call (settings change takes effect next turn)', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-test-'));
  try {
    await materializeCodexHome({ id: 'p', name: 'first', baseUrl: 'http://a/v1' }, baseDir);
    await materializeCodexHome({ id: 'p', name: 'second', baseUrl: 'http://b/v1' }, baseDir);
    const written = await fs.readFile(
      path.join(baseDir, 'codex-homes', 'p', 'config.toml'),
      'utf8',
    );
    assert.match(written, /name = "second"/);
    assert.match(written, /base_url = "http:\/\/b\/v1"/);
    assert.doesNotMatch(written, /"first"/);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
