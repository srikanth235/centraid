import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
// governance: allow-repo-hygiene file-size-limit (#363) single cross-repo interop suite against a real Clawgnition gateway (wrangler dev); the scenario is one coherent conformance run, not independently splittable cases
import { existsSync, readFileSync, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { providerConformanceCases } from "./conformance.js";
import type { ConformanceHarness } from "./conformance.js";
import { createKeyring } from "./crypto.js";
import type { Keyring } from "./crypto.js";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "./engine.js";
import type { SourceEntry } from "./engine.js";
import { BackupProviderError } from "./provider.js";
import { RemoteBackupProvider } from "./remote-provider.js";
import { S3TestServer } from "./testing/s3-test-server.js";
import { callProviderRoute } from "./wire-client.js";

function makeSqliteDbFile(filePath: string, vals: string[]): void {
  const conn = new DatabaseSync(filePath);
  conn.exec("PRAGMA journal_mode=WAL");
  conn.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, val TEXT NOT NULL)");
  const stmt = conn.prepare("INSERT INTO rows (val) VALUES (?)");
  for (const v of vals) stmt.run(v);
  conn.close(); // the last close checkpoints + deletes the WAL
}

function readSqliteRows(filePath: string): string[] {
  const conn = new DatabaseSync(filePath);
  try {
    return (
      conn.prepare("SELECT val FROM rows ORDER BY id").all() as {
        val: string;
      }[]
    ).map((r) => r.val);
  } finally {
    conn.close();
  }
}

async function fileSha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

const CLAWGNITION_REPO =
  process.env.CLAWGNITION_REPO ?? "/Users/srikanth/gitspace/clawgnition";
const GATEWAY_DIR = path.join(CLAWGNITION_REPO, "apps/gateway");
const DEV_VARS_FILE = path.join(GATEWAY_DIR, ".dev.vars");

function computeSkipReason(): string | null {
  if (process.env.CLAWGNITION_INTEROP !== "1") {
    return 'CLAWGNITION_INTEROP is not "1" — run `bun run test:interop` to opt in';
  }
  if (!existsSync(CLAWGNITION_REPO)) {
    return `CLAWGNITION_REPO not found at "${CLAWGNITION_REPO}"`;
  }
  if (!existsSync(DEV_VARS_FILE)) {
    return `Clawgnition gateway .dev.vars not found at "${DEV_VARS_FILE}" — see its docs/LOCAL_DEV_BACKUP.md`;
  }
  const vars = readFileSync(DEV_VARS_FILE, "utf8");
  if (!/^DEV_BACKUP_S3_ENDPOINT=.+$/mu.test(vars)) {
    return `DEV_BACKUP_S3_ENDPOINT is not set in "${DEV_VARS_FILE}" — the dev credentials fallback won't engage`;
  }
  return null;
}

const SKIP_REASON = computeSkipReason();
const SUITE_TITLE = SKIP_REASON
  ? `interop: Centraid backup client vs real Clawgnition gateway (SKIPPED — ${SKIP_REASON})`
  : "interop: Centraid backup client vs real Clawgnition gateway";

const GATEWAY_PORT = 9587;
const S3_PORT = 9099;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
const BUCKET = "clawgnition-vault-backups-dev";
const OPERATOR_EMAIL = "operator@clawgnition.local";
const OPERATOR_PASSWORD = "Operator123!";
const CURRENT = {
  gatewayVersion: "0.1.0",
  vaultUserVersion: "1",
  ontologyVersion: "1.2",
};
const APP_META = {
  gatewayVersion: "0.1.0",
  vaultUserVersion: "1",
  ontologyVersion: "1.2",
  sourceInstanceId: "interop-test",
};

async function assertPortFree(port: number, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `port ${port} (${label}) is already in use — stop whatever's bound to it (a stale ` +
              `wrangler dev? another S3TestServer?) and re-run`
          )
        );
      } else {
        reject(new Error(err.message, { cause: err }));
      }
    });
    srv.once("listening", () => srv.close(() => resolve()));
    srv.listen(port, "127.0.0.1");
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
  timeoutMs: number
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "pipe" });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${output.slice(-4000)}`
        )
      );
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(err.message, { cause: err }));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function runPredev(): Promise<void> {
  const { code, output } = await runCommand(
    "bun",
    ["run", "predev"],
    CLAWGNITION_REPO,
    120_000
  );
  if (code !== 0) {
    throw new Error(`bun run predev exited ${code}:\n${output.slice(-4000)}`);
  }
}

function spawnWranglerDev(): { child: ChildProcess; recentLog: () => string } {
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--port",
      String(GATEWAY_PORT),
      "--persist-to",
      ".wrangler/state",
    ],
    { cwd: GATEWAY_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  const lines: string[] = [];
  const capture = (d: Buffer) => {
    lines.push(d.toString());
    if (lines.length > 500) lines.shift();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, recentLog: () => lines.join("") };
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return; // group already gone
  }
  const timedOut = await Promise.race([
    exited.then(() => false),
    sleep(5000).then(() => true),
  ]);
  if (timedOut) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Intentionally empty.
    }
    await Promise.race([exited, sleep(2000)]);
  }
}

async function waitForGatewayUp(
  url: string,
  timeoutMs: number,
  recentLog: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no attempt made";
  const poll = async (): Promise<void> => {
    if (Date.now() >= deadline) {
      throw new Error(
        `clawgnition gateway did not come up at ${url} within ${timeoutMs}ms (last: ${lastErr})\n` +
          `--- recent wrangler output ---\n${recentLog().slice(-4000)}`
      );
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status === 401 || res.status === 200) return;
      lastErr = `unexpected status ${res.status}`;
    } catch (error) {
      lastErr = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000);
    return poll();
  };
  return poll();
}

async function mintRoutedApiKey(): Promise<string> {
  const signIn = await fetch(`${GATEWAY_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: OPERATOR_EMAIL,
      password: OPERATOR_PASSWORD,
    }),
  });
  if (!signIn.ok) {
    throw new Error(
      `operator sign-in failed (${signIn.status}): ${await signIn.text()}`
    );
  }
  const setCookie = signIn.headers.get("set-cookie") ?? "";
  const session = /better-auth\.session_token=[^;]+/u.exec(setCookie)?.[0];
  if (!session) {
    throw new Error(
      `operator sign-in returned no session cookie (set-cookie: ${setCookie})`
    );
  }
  let lastText = "";
  const mintAfterVerifierWarmup = async (attempt: number): Promise<string> => {
    if (attempt >= 10) {
      throw new Error(`POST /v1/keys never became available: ${lastText}`);
    }
    const minted = await fetch(`${GATEWAY_URL}/v1/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ name: "centraid-interop" }),
    });
    if (minted.ok) {
      const body = (await minted.json()) as { data?: { key?: string } };
      if (!body.data?.key)
        throw new Error(
          `POST /v1/keys returned no key: ${JSON.stringify(body)}`
        );
      return body.data.key;
    }
    lastText = await minted.text();
    if (minted.status === 503 && lastText.includes("key_delivery_pending")) {
      await sleep(500 * (attempt + 1));
      return mintAfterVerifierWarmup(attempt + 1);
    }
    throw new Error(`POST /v1/keys failed (${minted.status}): ${lastText}`);
  };
  return mintAfterVerifierWarmup(0);
}

describe.skipIf(SKIP_REASON !== null)(SUITE_TITLE, () => {
  let s3: S3TestServer;
  let gatewayProc: ChildProcess | undefined;
  let provider: RemoteBackupProvider;
  let apiKey: string;
  const createdTargetIds: string[] = [];

  beforeAll(async () => {
    await assertPortFree(S3_PORT, "S3 test server");
    await assertPortFree(GATEWAY_PORT, "clawgnition wrangler dev");

    s3 = await S3TestServer.start({ port: S3_PORT });

    const bootGateway = async (attempt: number): Promise<void> => {
      try {
        await runPredev();
        const spawned = spawnWranglerDev();
        gatewayProc = spawned.child;
        await waitForGatewayUp(
          `${GATEWAY_URL}/v1/storage/provider`,
          90_000,
          spawned.recentLog
        );
      } catch (error) {
        if (gatewayProc) {
          await killProcessTree(gatewayProc);
          gatewayProc = undefined;
        }
        if (attempt >= 2) throw error;
        console.warn(
          `[interop] gateway boot attempt ${attempt} failed (${error instanceof Error ? error.message : String(error)}); ` +
            `wiping .wrangler/state (known migration-0012 trap) and retrying once`
        );
        await fs.rm(path.join(GATEWAY_DIR, ".wrangler", "state"), {
          recursive: true,
          force: true,
        });
        return bootGateway(attempt + 1);
      }
    };
    await bootGateway(1);

    apiKey = await mintRoutedApiKey();
    provider = new RemoteBackupProvider({ baseUrl: GATEWAY_URL, apiKey });
  }, 240_000);

  afterAll(async () => {
    await forEachSequentially(createdTargetIds, async (id) => {
      await provider.deleteTarget(id).catch((error: unknown) => {
        console.warn(
          `[interop] cleanup: deleteTarget(${id}) failed: ${String(error)}`
        );
      });
    });
    if (gatewayProc) await killProcessTree(gatewayProc);
    if (s3) await s3.close();
  }, 120_000);

  async function freshTarget(label: string): Promise<string> {
    const { targetId } = await provider.createTarget({ label });
    createdTargetIds.push(targetId);
    return targetId;
  }

  describe("a. full conformance", () => {
    async function makeHarness(): Promise<ConformanceHarness> {
      return { provider, cleanup: async () => undefined };
    }

    test.each(
      providerConformanceCases(makeHarness).map((c) => [c.name, c] as const)
    )(
      "%s",
      async (_name, c) => {
        await c.run();
        expect(c.name.length).toBeGreaterThan(0);
      },
      90_000
    );
  });

  describe("b+c. real snapshot lifecycle over the wire", () => {
    const VAULT_ID = "interop-vault-1";
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

    test("b. createSnapshot registers against the real Worker+DO+D1, chunks/manifest land in the real S3 server; restoreSnapshot is byte-identical; verifySnapshot is clean", async () => {
      targetId = await freshTarget("interop-snapshot-lifecycle");

      const keyringDir = await tempDir("interop-keyring-");
      keyring = await createKeyring(path.join(keyringDir, "keyring.json"));

      sourceDir = await tempDir("interop-source-");
      await fs.mkdir(path.join(sourceDir, "blobs"), { recursive: true });
      makeSqliteDbFile(path.join(sourceDir, "vault.db"), ["v1", "v2", "v3"]);
      await fs.writeFile(
        path.join(sourceDir, "blobs", "photo.bin"),
        pseudoRandomBuffer(40_000, 3)
      );
      await fs.writeFile(
        path.join(sourceDir, "blobs", "big.bin"),
        pseudoRandomBuffer(33 * 1024 * 1024, 4)
      );
      const BASE_TICK = 1_752_480_000_000;
      entries = [
        {
          path: "vault.db",
          kind: "db",
          absolutePath: path.join(sourceDir, "vault.db"),
          sha256: await fileSha256(path.join(sourceDir, "vault.db")),
          walGeneration: "11".repeat(16),
          baseTickMs: BASE_TICK,
        },
        {
          path: "blobs/photo.bin",
          kind: "blob",
          absolutePath: path.join(sourceDir, "blobs", "photo.bin"),
        },
        {
          path: "blobs/big.bin",
          kind: "blob",
          absolutePath: path.join(sourceDir, "blobs", "big.bin"),
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

      const putKeys = s3.listDirect(BUCKET, `u/${targetId}/backup/`);
      expect(putKeys.some((k) => k.includes("/manifests/"))).toBe(true);
      expect(
        putKeys.filter((k) => k.includes("/chunks/")).length
      ).toBeGreaterThanOrEqual(5);

      const destDir = await tempDir("interop-restore-");
      const result = await restoreSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: VAULT_ID,
        destDir,
        current: CURRENT,
      });
      expect(result.seq).toBe(1);
      expect(result.entries.sort()).toStrictEqual(
        entries.map((e) => e.path).sort()
      );
      expect(readSqliteRows(path.join(destDir, "vault.db"))).toStrictEqual([
        "v1",
        "v2",
        "v3",
      ]);
      await Promise.all(
        entries
          .filter((e) => e.kind === "blob")
          .map(async (entry) => {
            const original = await fs.readFile(entry.absolutePath);
            const restored = await fs.readFile(
              path.join(destDir, ...entry.path.split("/"))
            );
            expect(restored.equals(original)).toBe(true);
          })
      );
      await fs.rm(destDir, { recursive: true, force: true });

      const verified = await verifySnapshot({
        provider,
        targetId,
        keyring,
        vaultId: VAULT_ID,
      });
      expect(verified.missing).toStrictEqual([]);
      expect(verified.corrupt).toStrictEqual([]);
    }, 90_000);

    test("c. deleting a chunk object directly against the real S3 server makes verifySnapshot report it missing", async () => {
      expect(targetId, "depends on test b having run first").toBeDefined();
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

  test("d. generation fencing + idempotency replay-before-fencing, against the real DO", async () => {
    const targetId = await freshTarget("interop-fencing");
    const base = {
      manifestHash: "d".repeat(64),
      totalBytes: 1,
      objectCount: 1,
      format: "centraid-snapshot/2",
      appMeta: {},
    };
    const manifestKeyFor = (name: string) =>
      `u/${targetId}/backup/manifests/${name}`;

    const gen2 = await provider.registerSnapshot(targetId, {
      ...base,
      idempotencyKey: "interop-gen2",
      manifestKey: manifestKeyFor("gen2.json"),
      generation: 2,
    });
    expect(gen2.generation).toBe(2);

    const err = await provider
      .registerSnapshot(targetId, {
        ...base,
        idempotencyKey: "interop-gen1-stale",
        manifestKey: manifestKeyFor("gen1.json"),
        generation: 1,
      })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(BackupProviderError);
    expect((err as BackupProviderError).code).toBe("conflict_generation");
    expect((err as BackupProviderError).details?.currentGeneration).toBe(2);

    const gen3 = await provider.registerSnapshot(targetId, {
      ...base,
      idempotencyKey: "interop-gen3",
      manifestKey: manifestKeyFor("gen3.json"),
      generation: 3,
    });
    expect(gen3.generation).toBe(3);

    const replay = await provider.registerSnapshot(targetId, {
      ...base,
      idempotencyKey: "interop-gen2",
      manifestKey: manifestKeyFor("gen2-REPLAY-DIFFERENT.json"),
      generation: 2,
    });
    expect(replay.generation).toBe(2);
    expect(replay.manifestKey).toBe(gen2.manifestKey);
  }, 90_000);

  test("e. a 'read' credential grant carries mode:'read'; our S3ObjectStore refuses put locally", async () => {
    const targetId = await freshTarget("interop-read-grant");

    const grant = await callProviderRoute<{ mode: string; bucket: string }>(
      { baseUrl: GATEWAY_URL, apiKey },
      "POST",
      `/v1/storage/vaults/${targetId}/credentials`,
      { ttlSeconds: 3600, mode: "read", store: "backup" }
    );
    expect(grant.mode).toBe("read");
    expect(grant.bucket).toBe(BUCKET);

    const readStore = await provider.openDataPlane(targetId, "backup", "read");
    await expect(
      readStore.put("chunks/nope", new Uint8Array([1]))
    ).rejects.toThrow(/read.*mode/iu);
  }, 90_000);

  test("f. getTarget/usage report real accountStatus/usage/currentGeneration from D1", async () => {
    const targetId = await freshTarget("interop-shape-check");
    await provider.registerSnapshot(targetId, {
      idempotencyKey: "interop-shape-1",
      manifestKey: `u/${targetId}/backup/manifests/shape-1.json`,
      manifestHash: "e".repeat(64),
      totalBytes: 4096,
      objectCount: 2,
      generation: 1,
      format: "centraid-snapshot/2",
      appMeta: {},
    });

    const info = await provider.getTarget(targetId);
    expect(info.id).toBe(targetId);
    expect(info.status).toBe("active");
    expect(info.currentGeneration).toBe(1);
    expect(info.usage.storedBytes).toBeTypeOf("number");
    expect(info.usage.objectCount).toBeTypeOf("number");

    const { usage, accountStatus } = await provider.usage(targetId);
    expect(["ok", "payment_due", "suspended"]).toContain(accountStatus);
    expect(usage.storedBytes).toBeTypeOf("number");
    expect(usage.objectCount).toBeTypeOf("number");
    expect([undefined, 107_374_182_400]).toContain(usage.quotaBytes);
  }, 90_000);
});
