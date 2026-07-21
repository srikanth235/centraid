import { tempDir } from '@centraid/test-kit/temp-dir';
// governance: allow-repo-hygiene file-size-limit (#363) single cross-repo interop suite against a real Clawgnition gateway (wrangler dev); the scenario is one coherent conformance run, not independently splittable cases
/*
 * Cross-repo interop: `RemoteBackupProvider` (this package's real client)
 * against a REAL Clawgnition `centraid-storage-provider/1` gateway running
 * under `wrangler dev` — real D1, real Durable Object fencing/idempotency,
 * real HTTP, with only the S3 data plane swapped for the local
 * `S3TestServer` (playing the role of R2, exactly as Clawgnition's own
 * `DEV_BACKUP_S3_*` local-dev fallback expects — see its
 * docs/LOCAL_DEV_BACKUP.md). Zero fakes of OUR code on either side.
 *
 * Gated so normal `vitest run` (and CI) skips this cleanly: it only runs
 * when `CLAWGNITION_INTEROP=1`, and self-skips with a clear reason if the
 * Clawgnition checkout or its dev credentials aren't where expected. Run it
 * explicitly with `bun run test:interop` (see package.json).
 *
 * History: this suite previously carried two `test.fails(...)` exemptions
 * in "a. full conformance" for confirmed Clawgnition-side bugs —
 * `POST /v1/storage/vaults/:id/snapshots` omitting `prunedAt`, and that same
 * route's response shape disagreeing with `GET .../snapshots/:seq` for the
 * identical row (extra `id`/`vaultId` fields, missing `prunedAt`). Both are
 * now fixed upstream (registration response matches the GET row shape
 * exactly) and the exemptions are removed — the full, unmodified
 * conformance kit runs and passes outright.
 *
 * One bug WAS found and fixed on the Centraid side while building this
 * suite (see `engine.ts`'s `createSnapshot` and `conformance.ts`'s
 * `manifestKeyFor`): PROTOCOL.md's own example showed a bare
 * `"manifestKey": "manifests/…"`, and both `LocalBackupProvider` and this
 * package's in-process fake gateway happily accepted that — but a live
 * Clawgnition gateway 400s it with `invalid_manifest_key`, because it
 * enforces manifestKey to literally start with the target's per-store
 * prefix (`u/{id}/backup/` since centraid-storage-provider/1)
 * prefix. Fixed by having `createSnapshot` (and the conformance kit's own
 * registration test data) build prefixed keys; PROTOCOL.md's example was
 * corrected to match.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { providerConformanceCases, type ConformanceHarness } from './conformance.js';
import { createKeyring, type Keyring } from './crypto.js';
import { createSnapshot, restoreSnapshot, verifySnapshot, type SourceEntry } from './engine.js';
import { BackupProviderError } from './provider.js';
import { RemoteBackupProvider } from './remote-provider.js';
import { S3TestServer } from './testing/s3-test-server.js';
import { callProviderRoute } from './wire-client.js';

// A `/1` coordinated base pair (vault.db + journal.db) must be a REAL
// WAL-quiet SQLite base carrying sha256 + walGeneration + baseTickMs — the
// snapshot engine verifies the base sha256 and runs (empty) WAL replay with a
// SQLite integrity check on restore, so random bytes cannot stand in. Helpers
// mirror engine.test.ts's fixtures.
function makeSqliteDbFile(filePath: string, vals: string[]): void {
  const conn = new DatabaseSync(filePath);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, val TEXT NOT NULL)');
  const stmt = conn.prepare('INSERT INTO rows (val) VALUES (?)');
  for (const v of vals) stmt.run(v);
  conn.close(); // closing the last connection checkpoints + deletes the WAL
}

function readSqliteRows(filePath: string): string[] {
  const conn = new DatabaseSync(filePath);
  try {
    return (conn.prepare('SELECT val FROM rows ORDER BY id').all() as { val: string }[]).map(
      (r) => r.val,
    );
  } finally {
    conn.close();
  }
}

async function fileSha256(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Gating — decided at collection time, synchronously, so `describe.skipIf`
// can act on it and the whole suite (including its `beforeAll`) is skipped
// cleanly with zero side effects when the env/checkout isn't set up.
// ---------------------------------------------------------------------------

const CLAWGNITION_REPO = process.env.CLAWGNITION_REPO ?? '/Users/srikanth/gitspace/clawgnition';
const GATEWAY_DIR = path.join(CLAWGNITION_REPO, 'apps/gateway');
const DEV_VARS_FILE = path.join(GATEWAY_DIR, '.dev.vars');

function computeSkipReason(): string | null {
  if (process.env.CLAWGNITION_INTEROP !== '1') {
    return 'CLAWGNITION_INTEROP is not "1" — run `bun run test:interop` to opt in';
  }
  if (!existsSync(CLAWGNITION_REPO)) {
    return `CLAWGNITION_REPO not found at "${CLAWGNITION_REPO}"`;
  }
  if (!existsSync(DEV_VARS_FILE)) {
    return `Clawgnition gateway .dev.vars not found at "${DEV_VARS_FILE}" — see its docs/LOCAL_DEV_BACKUP.md`;
  }
  const vars = readFileSync(DEV_VARS_FILE, 'utf8');
  if (!/^DEV_BACKUP_S3_ENDPOINT=.+$/m.test(vars)) {
    return `DEV_BACKUP_S3_ENDPOINT is not set in "${DEV_VARS_FILE}" — the dev credentials fallback won't engage`;
  }
  return null;
}

const SKIP_REASON = computeSkipReason();
const SUITE_TITLE = SKIP_REASON
  ? `interop: Centraid backup client vs real Clawgnition gateway (SKIPPED — ${SKIP_REASON})`
  : 'interop: Centraid backup client vs real Clawgnition gateway';

// ---------------------------------------------------------------------------
// Fixed dev-loop constants (match Clawgnition's docs/LOCAL_DEV_BACKUP.md and
// its predev-computed PORT_OFFSET for this branch, which happens to land the
// gateway on 9587 — see AGENT_ISSUE handoff notes; if that ever drifts,
// GATEWAY_PORT below is the one thing to change).
// ---------------------------------------------------------------------------

const GATEWAY_PORT = 9587;
const S3_PORT = 9099;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
const BUCKET = 'clawgnition-vault-backups-dev';
// Clawgnition auth is routed-key based (`sk-claw_v1_<cell>_<keyId>_<secret>`):
// flat seeded keys no longer authenticate. The suite signs in as the
// predev-seeded operator and mints a routed key over the real HTTP surface
// (`POST /v1/keys`) in beforeAll — the same path the dashboard takes.
const OPERATOR_EMAIL = 'operator@clawgnition.local';
const OPERATOR_PASSWORD = 'Operator123!';
const CURRENT = { gatewayVersion: '0.1.0', vaultUserVersion: '1', ontologyVersion: '1.2' };
const APP_META = {
  gatewayVersion: '0.1.0',
  vaultUserVersion: '1',
  ontologyVersion: '1.2',
  sourceInstanceId: 'interop-test',
};

// ---------------------------------------------------------------------------
// Process/port plumbing
// ---------------------------------------------------------------------------

async function assertPortFree(port: number, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `port ${port} (${label}) is already in use — stop whatever's bound to it (a stale ` +
              `wrangler dev? another S3TestServer?) and re-run`,
          ),
        );
      } else {
        reject(err);
      }
    });
    srv.once('listening', () => srv.close(() => resolve()));
    srv.listen(port, '127.0.0.1');
  });
}

interface RunResult {
  code: number | null;
  output: string;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'pipe' });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `${command} ${args.join(' ')} timed out after ${timeoutMs}ms\n${output.slice(-4000)}`,
        ),
      );
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** `bun run predev` — applies D1 migrations + seeds the fixed dev API key. Idempotent. (clawgnition is bun-managed; pnpm refuses to run there.) */
async function runPredev(): Promise<void> {
  const { code, output } = await runCommand('bun', ['run', 'predev'], CLAWGNITION_REPO, 120_000);
  if (code !== 0) {
    throw new Error(`bun run predev exited ${code}:\n${output.slice(-4000)}`);
  }
}

/** Spawns `wrangler dev` detached (its own process group) so `killProcessTree` can take out esbuild/workerd children with it, not just the `npx` shim. */
function spawnWranglerDev(): { child: ChildProcess; recentLog: () => string } {
  const child = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(GATEWAY_PORT), '--persist-to', '.wrangler/state'],
    { cwd: GATEWAY_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const lines: string[] = [];
  const capture = (d: Buffer) => {
    lines.push(d.toString());
    if (lines.length > 500) lines.shift();
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  return { child, recentLog: () => lines.join('') };
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return; // group already gone
  }
  const timedOut = await Promise.race([exited.then(() => false), sleep(5000).then(() => true)]);
  if (timedOut) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await Promise.race([exited, sleep(2000)]);
  }
}

/** Polls `GET /v1/storage/provider` — 401 (no bearer) or 200 both mean "the Worker is up and routing". */
async function waitForGatewayUp(
  url: string,
  timeoutMs: number,
  recentLog: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status === 401 || res.status === 200) return;
      lastErr = `unexpected status ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(1000);
  }
  throw new Error(
    `clawgnition gateway did not come up at ${url} within ${timeoutMs}ms (last: ${lastErr})\n` +
      `--- recent wrangler output ---\n${recentLog().slice(-4000)}`,
  );
}

/**
 * Sign in as the predev-seeded operator (Better Auth email/password) and mint
 * a routed api key via `POST /v1/keys` — the same flow the dashboard uses. No
 * `origin` header is sent: the gateway's CSRF guard treats origin-less
 * requests as non-browser clients and lets them through.
 */
async function mintRoutedApiKey(): Promise<string> {
  const signIn = await fetch(`${GATEWAY_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD }),
  });
  if (!signIn.ok) {
    throw new Error(`operator sign-in failed (${signIn.status}): ${await signIn.text()}`);
  }
  const setCookie = signIn.headers.get('set-cookie') ?? '';
  const session = /better-auth\.session_token=[^;]+/.exec(setCookie)?.[0];
  if (!session) {
    throw new Error(`operator sign-in returned no session cookie (set-cookie: ${setCookie})`);
  }
  // Right after a cold `wrangler dev` boot the USER_DO key-verifier snapshot
  // isn't warm yet, so the first mint can 503 with `key_delivery_pending`
  // ("Retry shortly."). Retry with backoff, exactly as the contract asks.
  let lastText = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    const minted = await fetch(`${GATEWAY_URL}/v1/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session },
      body: JSON.stringify({ name: 'centraid-interop' }),
    });
    if (minted.ok) {
      const body = (await minted.json()) as { data?: { key?: string } };
      if (!body.data?.key)
        throw new Error(`POST /v1/keys returned no key: ${JSON.stringify(body)}`);
      return body.data.key;
    }
    lastText = await minted.text();
    if (minted.status === 503 && lastText.includes('key_delivery_pending')) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    throw new Error(`POST /v1/keys failed (${minted.status}): ${lastText}`);
  }
  throw new Error(`POST /v1/keys never became available: ${lastText}`);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REASON !== null)(SUITE_TITLE, () => {
  let s3: S3TestServer;
  let gatewayProc: ChildProcess | undefined;
  let provider: RemoteBackupProvider;
  let apiKey: string;
  const createdTargetIds: string[] = [];

  beforeAll(async () => {
    await assertPortFree(S3_PORT, 'S3 test server');
    await assertPortFree(GATEWAY_PORT, 'clawgnition wrangler dev');

    s3 = await S3TestServer.start({ port: S3_PORT });

    // Boot the real gateway, with one retry that wipes local D1 state — a
    // known trap (a partially-applied migration 0012) leaves `wrangler dev`
    // unable to come up; `rm -rf .wrangler/state && pnpm predev` recovers.
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        await runPredev();
        const spawned = spawnWranglerDev();
        gatewayProc = spawned.child;
        await waitForGatewayUp(`${GATEWAY_URL}/v1/storage/provider`, 90_000, spawned.recentLog);
        break;
      } catch (err) {
        if (gatewayProc) {
          await killProcessTree(gatewayProc);
          gatewayProc = undefined;
        }
        if (attempt >= 2) throw err;
        console.warn(
          `[interop] gateway boot attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}); ` +
            `wiping .wrangler/state (known migration-0012 trap) and retrying once`,
        );
        await fs.rm(path.join(GATEWAY_DIR, '.wrangler', 'state'), { recursive: true, force: true });
      }
    }

    apiKey = await mintRoutedApiKey();
    provider = new RemoteBackupProvider({ baseUrl: GATEWAY_URL, apiKey });
  }, 240_000);

  afterAll(async () => {
    // Soft-delete every target this run created — purge is (correctly)
    // impossible with an api-key (see scenario "d" / conformance's
    // "purge (tier-gated)"). Local D1 state itself is disposable
    // (`rm -rf apps/gateway/.wrangler/state`), so this is just hygiene, not
    // a correctness requirement for the next run.
    for (const id of createdTargetIds) {
      await provider.deleteTarget(id).catch((err: unknown) => {
        console.warn(`[interop] cleanup: deleteTarget(${id}) failed: ${String(err)}`);
      });
    }
    if (gatewayProc) await killProcessTree(gatewayProc);
    if (s3) await s3.close();
  }, 120_000);

  async function freshTarget(label: string): Promise<string> {
    const { targetId } = await provider.createTarget({ label });
    createdTargetIds.push(targetId);
    return targetId;
  }

  // -------------------------------------------------------------------------
  // a. Full conformance
  // -------------------------------------------------------------------------
  describe('a. full conformance', () => {
    async function makeHarness(): Promise<ConformanceHarness> {
      return { provider, cleanup: async () => undefined };
    }

    // The full, unmodified kit — no exemptions. Both previously-confirmed
    // response-shape bugs (see module header) are fixed upstream.
    for (const c of providerConformanceCases(makeHarness)) {
      // Generous per-case timeout: the dev gateway's per-cell auth rate limit
      // (60 req / 60 s, no Retry-After) can force the client to wait out a full
      // window mid-case; the wire client's bounded backoff needs room to do so.
      test(c.name, c.run, 90_000);
    }
  });

  // -------------------------------------------------------------------------
  // b + c. Real snapshot -> restore over the wire, then verify catches real
  // loss. Sequential/stateful on purpose — c corrupts the snapshot b built.
  // -------------------------------------------------------------------------
  describe('b+c. real snapshot lifecycle over the wire', () => {
    const VAULT_ID = 'interop-vault-1';
    let targetId: string;
    let keyring: Keyring;
    let sourceDir: string;
    let entries: SourceEntry[];
    let snapshotSeq: number;

    function pseudoRandomBuffer(size: number, seed: number): Uint8Array {
      let x = seed >>> 0 || 1;
      const buf = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        x ^= x << 13;
        x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        buf[i] = x & 0xff;
      }
      return buf;
    }

    test('b. createSnapshot registers against the real Worker+DO+D1, chunks/manifest land in the real S3 server; restoreSnapshot is byte-identical; verifySnapshot is clean', async () => {
      targetId = await freshTarget('interop-snapshot-lifecycle');

      const keyringDir = await tempDir('interop-keyring-');
      keyring = await createKeyring(path.join(keyringDir, 'keyring.json'));

      sourceDir = await tempDir('interop-source-');
      await fs.mkdir(path.join(sourceDir, 'blobs'), { recursive: true });
      // Real WAL-quiet SQLite bases (the `/1` coordinated pair); the engine
      // verifies their sha256 and runs an integrity-checked WAL replay on
      // restore, so these cannot be random bytes.
      makeSqliteDbFile(path.join(sourceDir, 'vault.db'), ['v1', 'v2', 'v3']);
      makeSqliteDbFile(path.join(sourceDir, 'journal.db'), ['j1']);
      await fs.writeFile(path.join(sourceDir, 'blobs', 'photo.bin'), pseudoRandomBuffer(40_000, 3));
      // Large blob: 33 MiB of incompressible bytes so a SINGLE entry spans
      // MULTIPLE 16 MiB parts (#405 §1 acceptance — the old interop topped out
      // at 1.5 MiB, one part). Incompressible on purpose: it stores RAW under
      // the keep-if-smaller gate (each part costs the 1 frame byte, no
      // inflation) while still exercising many-object seal/upload/restore
      // reassembly against the real S3 server. (Fixed 16 MiB parts — centraid
      // no longer content-defined-chunks, so size, not entropy, sets the part
      // count.)
      await fs.writeFile(
        path.join(sourceDir, 'blobs', 'big.bin'),
        pseudoRandomBuffer(33 * 1024 * 1024, 4),
      );
      const BASE_TICK = 1_752_480_000_000;
      entries = [
        {
          path: 'vault.db',
          kind: 'db',
          absolutePath: path.join(sourceDir, 'vault.db'),
          sha256: await fileSha256(path.join(sourceDir, 'vault.db')),
          walGeneration: '11'.repeat(16),
          baseTickMs: BASE_TICK,
        },
        {
          path: 'journal.db',
          kind: 'db',
          absolutePath: path.join(sourceDir, 'journal.db'),
          sha256: await fileSha256(path.join(sourceDir, 'journal.db')),
          // Same tick as the vault base — the shipper breaks both generations
          // together and restore refuses a pair that cannot show it.
          walGeneration: '22'.repeat(16),
          baseTickMs: BASE_TICK,
        },
        {
          path: 'blobs/photo.bin',
          kind: 'blob',
          absolutePath: path.join(sourceDir, 'blobs', 'photo.bin'),
        },
        {
          path: 'blobs/big.bin',
          kind: 'blob',
          absolutePath: path.join(sourceDir, 'blobs', 'big.bin'),
        },
      ];

      const row = await createSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: VAULT_ID,
        entries,
        generation: 1,
        appMeta: APP_META,
      });
      expect(row).not.toBeNull();
      expect(row?.seq).toBe(1);
      snapshotSeq = row!.seq;

      // The manifest + every chunk really landed in the real S3 server
      // (not a fake) under this target's vault prefix. `listDirect`
      // returns keys relative to the bucket (the queried prefix is NOT
      // stripped) — chunk keys land at "vaults/{id}/chunks/{cid}", but the
      // manifest key lands one level deeper, at
      // "vaults/{id}/vaults/{id}/manifests/…" (see engine.ts's
      // `createSnapshot` comment: the wire `manifestKey` MUST itself start
      // with "vaults/{id}/" per PROTOCOL.md, and it's used unchanged as
      // the ObjectStore key too, which is *already* scoped under the
      // grant's own "vaults/{id}/" prefix) — hence `includes`, not
      // `startsWith`, below.
      const putKeys = s3.listDirect(BUCKET, `u/${targetId}/backup/`);
      expect(putKeys.some((k) => k.includes('/manifests/'))).toBe(true);
      // The 33 MiB blob alone splits into ceil(33/16)=3 fixed parts, so the
      // snapshot lands several distinct chunk objects — a single entry now
      // genuinely spans multiple parts (not four one-part files masquerading
      // as "multi-chunked").
      expect(putKeys.filter((k) => k.includes('/chunks/')).length).toBeGreaterThanOrEqual(5);

      const destDir = await tempDir('interop-restore-');
      const result = await restoreSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: VAULT_ID,
        destDir,
        current: CURRENT,
      });
      expect(result.seq).toBe(1);
      expect(result.entries.sort()).toEqual(entries.map((e) => e.path).sort());
      // The db bases restore + replay to logically-identical SQLite content
      // (WAL replay reopens/checkpoints the file, so the bytes need not match);
      // the opaque blobs restore byte-identical.
      expect(readSqliteRows(path.join(destDir, 'vault.db'))).toEqual(['v1', 'v2', 'v3']);
      expect(readSqliteRows(path.join(destDir, 'journal.db'))).toEqual(['j1']);
      for (const entry of entries.filter((e) => e.kind === 'blob')) {
        const original = await fs.readFile(entry.absolutePath);
        const restored = await fs.readFile(path.join(destDir, ...entry.path.split('/')));
        expect(restored.equals(original)).toBe(true);
      }
      await fs.rm(destDir, { recursive: true, force: true });

      const verified = await verifySnapshot({ provider, targetId, keyring, vaultId: VAULT_ID });
      expect(verified.missing).toEqual([]);
      expect(verified.corrupt).toEqual([]);
    }, 90_000);

    test('c. deleting a chunk object directly against the real S3 server makes verifySnapshot report it missing', async () => {
      expect(targetId, 'depends on test b having run first').toBeDefined();
      // `listDirect`'s keys are already bucket-relative (see the comment
      // in test "b") — directly usable with `deleteObjectDirect`.
      const chunkKeys = s3.listDirect(BUCKET, `u/${targetId}/backup/chunks/`);
      expect(chunkKeys.length).toBeGreaterThan(0);
      const victim = chunkKeys[0]!;
      expect(s3.deleteObjectDirect(BUCKET, victim)).toBe(true);

      const verified = await verifySnapshot({
        provider,
        targetId,
        keyring,
        vaultId: VAULT_ID,
        seq: snapshotSeq,
      });
      expect(verified.missing.length).toBeGreaterThan(0);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  // d. Fencing against the real Durable Object
  // -------------------------------------------------------------------------
  test('d. generation fencing + idempotency replay-before-fencing, against the real DO', async () => {
    const targetId = await freshTarget('interop-fencing');
    const base = {
      manifestHash: 'd'.repeat(64),
      totalBytes: 1,
      objectCount: 1,
      format: 'centraid-snapshot/2',
      appMeta: {},
    };
    const manifestKeyFor = (name: string) => `u/${targetId}/backup/manifests/${name}`;

    // Takeover: register gen 2 first (currentGeneration starts at 0).
    const gen2 = await provider.registerSnapshot(targetId, {
      ...base,
      idempotencyKey: 'interop-gen2',
      manifestKey: manifestKeyFor('gen2.json'),
      generation: 2,
    });
    expect(gen2.generation).toBe(2);

    // The superseded writer's gen 1 attempt 409s with the real current gen.
    const err = await provider
      .registerSnapshot(targetId, {
        ...base,
        idempotencyKey: 'interop-gen1-stale',
        manifestKey: manifestKeyFor('gen1.json'),
        generation: 1,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupProviderError);
    expect((err as BackupProviderError).code).toBe('conflict_generation');
    expect((err as BackupProviderError).details?.currentGeneration).toBe(2);

    // gen 3 (a legitimate next write) is accepted.
    const gen3 = await provider.registerSnapshot(targetId, {
      ...base,
      idempotencyKey: 'interop-gen3',
      manifestKey: manifestKeyFor('gen3.json'),
      generation: 3,
    });
    expect(gen3.generation).toBe(3);

    // Idempotency replay of the ORIGINAL gen-2 registration must return
    // the cached row (no conflict), even though currentGeneration is now
    // 3 — the DO checks idempotency BEFORE fencing (replay-before-fencing,
    // verified here over the real wire, not just the reference DO's own
    // unit tests).
    const replay = await provider.registerSnapshot(targetId, {
      ...base,
      idempotencyKey: 'interop-gen2',
      manifestKey: manifestKeyFor('gen2-REPLAY-DIFFERENT.json'),
      generation: 2,
    });
    expect(replay.generation).toBe(2);
    expect(replay.manifestKey).toBe(gen2.manifestKey);
  }, 90_000);

  // -------------------------------------------------------------------------
  // e. Read-mode grant
  // -------------------------------------------------------------------------
  test("e. a 'read' credential grant carries mode:'read'; our S3ObjectStore refuses put locally", async () => {
    const targetId = await freshTarget('interop-read-grant');

    // The grant mode assertion needs the raw wire response — RemoteBackupProvider
    // doesn't surface the grant object itself, only an already-wrapped ObjectStore.
    // Go through `callProviderRoute` (not a bare fetch) so the same backpressure
    // handling that carries every other case through the dev gateway's per-cell
    // auth rate limit applies here too.
    const grant = await callProviderRoute<{ mode: string; bucket: string }>(
      { baseUrl: GATEWAY_URL, apiKey },
      'POST',
      `/v1/storage/vaults/${targetId}/credentials`,
      { ttlSeconds: 3600, mode: 'read', store: 'backup' },
    );
    expect(grant.mode).toBe('read');
    expect(grant.bucket).toBe(BUCKET);

    // Enforcement that a 'read' grant can't write is CLIENT-side by design
    // (PROTOCOL.md: providers issue prefix-scoped creds but the data plane
    // itself is bare S3 — nothing server-side stops the bytes on the wire
    // with these particular static dev credentials, which carry no IAM
    // policy). `S3ObjectStore.put` refuses locally based on `grant.mode`
    // before ever making the request — that's what this asserts.
    const readStore = await provider.openDataPlane(targetId, 'backup', 'read');
    await expect(readStore.put('chunks/nope', new Uint8Array([1]))).rejects.toThrow(/read.*mode/i);
  }, 90_000);

  // -------------------------------------------------------------------------
  // f. accountStatus / usage / currentGeneration shape against real rows
  // -------------------------------------------------------------------------
  test('f. getTarget/usage report real accountStatus/usage/currentGeneration from D1', async () => {
    const targetId = await freshTarget('interop-shape-check');
    await provider.registerSnapshot(targetId, {
      idempotencyKey: 'interop-shape-1',
      manifestKey: `u/${targetId}/backup/manifests/shape-1.json`,
      manifestHash: 'e'.repeat(64),
      totalBytes: 4096,
      objectCount: 2,
      generation: 1,
      format: 'centraid-snapshot/2',
      appMeta: {},
    });

    const info = await provider.getTarget(targetId);
    expect(info.id).toBe(targetId);
    expect(info.status).toBe('active');
    expect(info.currentGeneration).toBe(1);
    expect(typeof info.usage.storedBytes).toBe('number');
    expect(typeof info.usage.objectCount).toBe('number');

    const { usage, accountStatus } = await provider.usage(targetId);
    expect(['ok', 'payment_due', 'suspended']).toContain(accountStatus);
    expect(typeof usage.storedBytes).toBe('number');
    expect(typeof usage.objectCount).toBe('number');
    if (usage.quotaBytes !== undefined) {
      expect(usage.quotaBytes).toBe(107_374_182_400); // pro tier: 100 GiB (packages/db migration 0012)
    }
  }, 90_000);
});
