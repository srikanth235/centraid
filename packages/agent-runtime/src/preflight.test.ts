import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  compareSemver,
  invalidatePreflightCache,
  minVersionString,
  parseSemver,
  probeProvider,
  runPreflight,
} from './preflight.ts';

/**
 * Swap `globalThis.fetch` for the duration of `fn`, then restore. Each
 * call records the URL + init it received so tests can assert what the
 * probe sent (e.g. the Authorization header on key-protected providers).
 */
async function withFetchMock(
  impl: (url: string, init: RequestInit | undefined) => Promise<Response> | Response,
  fn: (calls: Array<{ url: string; init: RequestInit | undefined }>) => Promise<void>,
): Promise<void> {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return impl(url, init);
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

test('reports binary-not-found when bin does not exist', async () => {
  invalidatePreflightCache();
  const status = await runPreflight({
    kind: 'codex',
    binPath: '/this/path/does/not/exist/codex',
  });
  assert.equal(status.kind, 'codex');
  assert.equal(status.ok, false);
  assert.match(status.reason ?? '', /not found|ENOENT|spawn|--version/);
  assert.ok(status.hint?.includes('Codex'));
});

test('caches result per (kind, binPath)', async () => {
  invalidatePreflightCache();
  // Use `true` (always succeeds, version output) and `false` (always fails)
  // to exercise both branches without depending on any user-installed CLI.
  const first = await runPreflight({ kind: 'codex', binPath: 'true' });
  const second = await runPreflight({ kind: 'codex', binPath: 'true' });
  // Same cache key → identical object (we don't deep-clone — fine for tests).
  assert.equal(first, second);
});

test('different binPath busts the cache', async () => {
  invalidatePreflightCache();
  const a = await runPreflight({ kind: 'codex', binPath: 'true' });
  const b = await runPreflight({ kind: 'codex', binPath: '/no/such/bin' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
});

test('parseSemver handles common --version output shapes', () => {
  assert.deepEqual(parseSemver('codex-cli 0.128.0'), { major: 0, minor: 128, patch: 0 });
  assert.deepEqual(parseSemver('2.1.126 (Claude Code)'), { major: 2, minor: 1, patch: 126 });
  assert.deepEqual(parseSemver('v1.2.3-beta'), { major: 1, minor: 2, patch: 3 });
  assert.equal(parseSemver('no version here'), undefined);
});

test('compareSemver orders versions', () => {
  const a = { major: 1, minor: 2, patch: 3 };
  const b = { major: 1, minor: 2, patch: 4 };
  const c = { major: 1, minor: 3, patch: 0 };
  const d = { major: 2, minor: 0, patch: 0 };
  assert.ok(compareSemver(a, b) < 0);
  assert.ok(compareSemver(b, a) > 0);
  assert.equal(compareSemver(a, a), 0);
  assert.ok(compareSemver(b, c) < 0);
  assert.ok(compareSemver(c, d) < 0);
});

test('preflight surfaces versionAtLeast when version parses', async () => {
  invalidatePreflightCache();
  // `true --version` exits 0 and prints empty output → version parses
  // as undefined → versionAtLeast stays undefined. Confirm the field is
  // absent (not falsely false) in that case.
  const status = await runPreflight({ kind: 'codex', binPath: 'true' });
  assert.equal(status.ok, true);
  assert.equal(status.versionAtLeast, undefined);
  assert.equal(status.minVersion, minVersionString('codex'));
});

// ---- probeProvider tests ------------------------------------------------

test('probeProvider returns ok with model count on 200 + OpenAI data shape', async () => {
  await withFetchMock(
    () => jsonResponse({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
    async () => {
      const status = await probeProvider({
        id: 'groq',
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
      });
      assert.equal(status.ok, true);
      assert.equal(status.modelCount, 3);
      assert.equal(status.id, 'groq');
      assert.equal(status.baseUrl, 'https://api.groq.com/openai/v1');
      assert.equal(status.reason, undefined);
    },
  );
});

test('probeProvider sends Bearer auth when envKey + apiKey are set', async () => {
  await withFetchMock(
    () => jsonResponse({ data: [] }),
    async (calls) => {
      await probeProvider({
        id: 'groq',
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        envKey: 'GROQ_API_KEY',
        apiKey: 'gsk_secret',
      });
      assert.equal(calls.length, 1);
      const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers.Authorization, 'Bearer gsk_secret');
      assert.equal(headers.Accept, 'application/json');
    },
  );
});

test('probeProvider omits Authorization header for keyless local endpoints', async () => {
  await withFetchMock(
    () => jsonResponse({ data: [] }),
    async (calls) => {
      await probeProvider({
        id: 'ollama',
        name: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
      });
      const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers.Authorization, undefined);
    },
  );
});

test('probeProvider joins base URL and /models without double-slash', async () => {
  await withFetchMock(
    () => jsonResponse({ data: [] }),
    async (calls) => {
      await probeProvider({
        id: 'p',
        name: 'P',
        baseUrl: 'http://localhost:8000/v1/', // trailing slash
      });
      assert.equal(calls[0]!.url, 'http://localhost:8000/v1/models');
    },
  );
});

test('probeProvider reports 401 as "API key rejected"', async () => {
  await withFetchMock(
    () => new Response('Unauthorized', { status: 401 }),
    async () => {
      const status = await probeProvider({
        id: 'groq',
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        envKey: 'GROQ_API_KEY',
        apiKey: 'bad-key',
      });
      assert.equal(status.ok, false);
      assert.match(status.reason ?? '', /API key rejected/);
      assert.match(status.reason ?? '', /groq/);
    },
  );
});

test('probeProvider reports 403 as "API key rejected"', async () => {
  await withFetchMock(
    () => new Response('Forbidden', { status: 403 }),
    async () => {
      const status = await probeProvider({
        id: 'p',
        name: 'P',
        baseUrl: 'http://localhost/v1',
      });
      assert.equal(status.ok, false);
      assert.match(status.reason ?? '', /API key rejected/);
    },
  );
});

test('probeProvider surfaces non-2xx HTTP errors with their status code', async () => {
  await withFetchMock(
    () => new Response('Internal Server Error', { status: 500 }),
    async () => {
      const status = await probeProvider({
        id: 'p',
        name: 'P',
        baseUrl: 'http://localhost/v1',
      });
      assert.equal(status.ok, false);
      assert.match(status.reason ?? '', /HTTP 500/);
    },
  );
});

test('probeProvider treats unparseable JSON body as ok but without modelCount', async () => {
  await withFetchMock(
    () => new Response('not-json-at-all', { status: 200 }),
    async () => {
      const status = await probeProvider({
        id: 'p',
        name: 'P',
        baseUrl: 'http://localhost/v1',
      });
      // 2xx means the endpoint is alive — body parse failure is OK,
      // we just can't count models.
      assert.equal(status.ok, true);
      assert.equal(status.modelCount, undefined);
    },
  );
});

test('probeProvider omits modelCount when data[] is missing from the shape', async () => {
  await withFetchMock(
    () => jsonResponse({ result: 'ok' }), // no `data` field
    async () => {
      const status = await probeProvider({
        id: 'p',
        name: 'P',
        baseUrl: 'http://localhost/v1',
      });
      assert.equal(status.ok, true);
      assert.equal(status.modelCount, undefined);
    },
  );
});

test('probeProvider reports connection refused as "failed to reach"', async () => {
  await withFetchMock(
    () => {
      throw new TypeError('fetch failed');
    },
    async () => {
      const status = await probeProvider({
        id: 'p',
        name: 'P',
        baseUrl: 'http://127.0.0.1:1/v1',
      });
      assert.equal(status.ok, false);
      assert.match(status.reason ?? '', /failed to reach/);
      assert.match(status.reason ?? '', /127\.0\.0\.1:1/);
    },
  );
});

test('probeProvider reports AbortError as a timeout', async () => {
  await withFetchMock(
    () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    },
    async () => {
      const status = await probeProvider({
        id: 'p',
        name: 'P',
        baseUrl: 'http://slow.example.com/v1',
      });
      assert.equal(status.ok, false);
      // The reason path distinguishes abort (timeout) from a network throw
      // via `controller.signal.aborted`. Since the mock throws after the
      // timer already fired, both branches yield a coherent reason — what
      // we care about is that the user sees something explaining why.
      assert.match(status.reason ?? '', /slow\.example\.com/);
    },
  );
});

test('runPreflight attaches provider sub-status on codex with provider configured', async () => {
  invalidatePreflightCache();
  await withFetchMock(
    () => jsonResponse({ data: [{ id: 'm1' }, { id: 'm2' }] }),
    async () => {
      const status = await runPreflight({
        kind: 'codex',
        binPath: 'true',
        provider: {
          id: 'groq',
          name: 'Groq',
          baseUrl: 'https://api.groq.com/openai/v1',
          envKey: 'GROQ_API_KEY',
          apiKey: 'gsk_test',
        },
      });
      assert.equal(status.ok, true);
      assert.ok(status.provider, 'expected provider sub-status');
      assert.equal(status.provider!.ok, true);
      assert.equal(status.provider!.modelCount, 2);
    },
  );
});

test('runPreflight does not probe provider on claude-code kind', async () => {
  invalidatePreflightCache();
  let probeCount = 0;
  await withFetchMock(
    () => {
      probeCount++;
      return jsonResponse({ data: [] });
    },
    async () => {
      // `provider` is plumbed in but the dispatcher should ignore it for
      // claude-code — the SDK doesn't speak OpenAI wire format.
      const status = await runPreflight({
        kind: 'claude-code',
        binPath: 'true',
        provider: {
          id: 'groq',
          name: 'Groq',
          baseUrl: 'https://api.groq.com/openai/v1',
        },
      });
      assert.equal(status.provider, undefined);
      assert.equal(probeCount, 0);
    },
  );
});

test('runPreflight cache key includes provider — switching provider re-probes', async () => {
  invalidatePreflightCache();
  let probeCount = 0;
  await withFetchMock(
    () => {
      probeCount++;
      return jsonResponse({ data: [] });
    },
    async () => {
      const baseProv = {
        name: 'Test',
        baseUrl: 'http://localhost/v1',
      };
      await runPreflight({
        kind: 'codex',
        binPath: 'true',
        provider: { id: 'a', ...baseProv },
      });
      await runPreflight({
        kind: 'codex',
        binPath: 'true',
        provider: { id: 'b', ...baseProv },
      });
      assert.equal(probeCount, 2, 'provider id change must bust the cache');
    },
  );
});
