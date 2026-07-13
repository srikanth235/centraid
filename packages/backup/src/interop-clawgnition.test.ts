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
 * `POST /v1/backup/vaults/:id/snapshots` omitting `prunedAt`, and that same
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
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { providerConformanceCases, type ConformanceHarness } from './conformance.js';
import { createKeyring, type Keyring } from './crypto.js';
import { createSnapshot, restoreSnapshot, verifySnapshot, type SourceEntry } from './engine.js';
import { BackupProviderError } from './provider.js';
import { RemoteBackupProvider } from './remote-provider.js';
import { S3TestServer } from './testing/s3-test-server.js';

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
const API_KEY = 'sk-claw_operator_dev_fixed_key_0001';
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

/** `pnpm predev` — applies D1 migrations + seeds the fixed dev API key. Idempotent. */
async function runPredev(): Promise<void> {
  const { code, output } = await runCommand('pnpm', ['predev'], CLAWGNITION_REPO, 120_000);
  if (code !== 0) {
    throw new Error(`pnpm predev exited ${code}:\n${output.slice(-4000)}`);
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

/** Polls `GET /v1/backup/provider` — 401 (no bearer) or 200 both mean "the Worker is up and routing". */
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REASON !== null)(SUITE_TITLE, () => {
  let s3: S3TestServer;
  let gatewayProc: ChildProcess | undefined;
  let provider: RemoteBackupProvider;
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
        await waitForGatewayUp(`${GATEWAY_URL}/v1/backup/provider`, 90_000, spawned.recentLog);
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

    provider = new RemoteBackupProvider({ baseUrl: GATEWAY_URL, apiKey: API_KEY });
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
  }, 30_000);

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
      test(c.name, c.run, 30_000);
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

      const keyringDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-keyring-'));
      keyring = await createKeyring(path.join(keyringDir, 'keyring.json'));

      sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interop-source-'));
      await fs.mkdir(path.join(sourceDir, 'blobs'), { recursive: true });
      // >1MiB, incompressible-ish content — FastCDC's min chunk is 512KiB
      // (FORMAT.md), so this reliably spans multiple chunks.
      await fs.writeFile(
        path.join(sourceDir, 'vault.db'),
        pseudoRandomBuffer(1.5 * 1024 * 1024, 1),
      );
      await fs.writeFile(path.join(sourceDir, 'journal.db'), pseudoRandomBuffer(8_000, 2));
      await fs.writeFile(path.join(sourceDir, 'blobs', 'photo.bin'), pseudoRandomBuffer(40_000, 3));
      entries = [
        { path: 'vault.db', kind: 'db', absolutePath: path.join(sourceDir, 'vault.db') },
        { path: 'journal.db', kind: 'db', absolutePath: path.join(sourceDir, 'journal.db') },
        {
          path: 'blobs/photo.bin',
          kind: 'blob',
          absolutePath: path.join(sourceDir, 'blobs', 'photo.bin'),
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
      expect(putKeys.filter((k) => k.includes('/chunks/')).length).toBeGreaterThan(1); // multi-chunked

      const destDir = path.join(os.tmpdir(), `interop-restore-${Date.now()}`);
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
      for (const entry of entries) {
        const original = await fs.readFile(entry.absolutePath);
        const restored = await fs.readFile(path.join(destDir, ...entry.path.split('/')));
        expect(restored.equals(original)).toBe(true);
      }
      await fs.rm(destDir, { recursive: true, force: true });

      const verified = await verifySnapshot({ provider, targetId, keyring, vaultId: VAULT_ID });
      expect(verified.missing).toEqual([]);
      expect(verified.corrupt).toEqual([]);
    }, 60_000);

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
    }, 30_000);
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
      format: 'centraid-snapshot/1',
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
  }, 30_000);

  // -------------------------------------------------------------------------
  // e. Read-mode grant
  // -------------------------------------------------------------------------
  test("e. a 'read' credential grant carries mode:'read'; our S3ObjectStore refuses put locally", async () => {
    const targetId = await freshTarget('interop-read-grant');

    // The grant mode assertion needs the raw wire response — RemoteBackupProvider
    // doesn't surface the grant object itself, only an already-wrapped ObjectStore.
    const res = await fetch(`${GATEWAY_URL}/v1/backup/vaults/${targetId}/credentials`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 3600, mode: 'read', store: 'backup' }),
    });
    const body = (await res.json()) as { data: { mode: string; bucket: string } };
    expect(body.data.mode).toBe('read');
    expect(body.data.bucket).toBe(BUCKET);

    // Enforcement that a 'read' grant can't write is CLIENT-side by design
    // (PROTOCOL.md: providers issue prefix-scoped creds but the data plane
    // itself is bare S3 — nothing server-side stops the bytes on the wire
    // with these particular static dev credentials, which carry no IAM
    // policy). `S3ObjectStore.put` refuses locally based on `grant.mode`
    // before ever making the request — that's what this asserts.
    const readStore = await provider.openDataPlane(targetId, 'backup', 'read');
    await expect(readStore.put('chunks/nope', new Uint8Array([1]))).rejects.toThrow(/read.*mode/i);
  }, 30_000);

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
      format: 'centraid-snapshot/1',
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
  }, 30_000);
});
