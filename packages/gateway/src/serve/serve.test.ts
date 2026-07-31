import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.ts";
import { serve } from "./serve.ts";
import type { GatewayServeHandle } from "./serve.ts";

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, "vault"),
  };
}

async function verifyCurrentRecoveryKit(
  active: GatewayServeHandle,
  auth: Record<string, string>
): Promise<{ confirmedAt: number }> {
  const password = "correct horse battery staple";
  const kitResponse = await fetch(
    `${active.url}/centraid/_gateway/backup/kit`,
    {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }
  );
  expect(kitResponse.status).toBe(200);
  const kit = await kitResponse.json();
  const confirm = await fetch(
    `${active.url}/centraid/_gateway/backup/kit-confirmed`,
    {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ kit, password, lossConsent: true }),
    }
  );
  expect(confirm.status).toBe(200);
  return confirm.json() as Promise<{ confirmedAt: number }>;
}

describe("serve scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`gateway-runtime-${crypto.randomUUID()}-`);
    handle = await serve({ paths: pathsUnder(dataDir) });
  }, 30_000);

  afterEach(async () => {
    await handle.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("binds to loopback by default and mints a 32-byte random token", () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(handle.token).toHaveLength(64);
  });

  test("activates the vault workspace so its apps dir exists (#280)", async () => {
    const vaultId = handle.vaults.current().boot.vaultId;
    const stat = await fs.stat(path.join(dataDir, "vault", vaultId, "apps"));
    expect(stat.isDirectory()).toBeTruthy();
  });

  test("returns the constructed stores on the handle for host introspection", () => {
    expect(handle.prefs).toBeTruthy();
    expect(handle.analyticsStore).toBeTruthy();
    expect(handle.conversationHistoryStore).toBeTruthy();
    expect(handle.runtime).toBeTruthy();
  });

  test("rejects /centraid/_apps without the bearer token", async () => {
    const res = await fetch(`${handle.url}/centraid/_apps`);
    expect(res.status).toBe(401);
  });

  test("serves /centraid/_apps when the bearer token matches", async () => {
    const res = await fetch(`${handle.url}/centraid/_apps`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toStrictEqual([]);
  });

  test("honors a caller-supplied token instead of minting one", async () => {
    await handle.close();
    const fixed = "fixed-token-for-test-purposes-only-do-not-use-elsewhere";
    handle = await serve({
      paths: pathsUnder(dataDir),
      token: fixed,
    });
    expect(handle.token).toBe(fixed);
    const res = await fetch(`${handle.url}/centraid/_apps`, {
      headers: { Authorization: `Bearer ${fixed}` },
    });
    expect(res.status).toBe(200);
  });

  test("honors a caller-supplied host (loopback alias still resolves)", async () => {
    await handle.close();
    handle = await serve({
      paths: pathsUnder(dataDir),
      host: "127.0.0.1",
      port: 0,
    });
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });

  test("runnerStatus is reachable and returns a RunnerStatus body", async () => {
    const res = await fetch(`${handle.url}/centraid/_turn/runner-status`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    // Whether the runner shows `ok` depends on whether codex / claude-code
    // is installed on the test host. We only assert the route is mounted
    // and returns a well-shaped status (the Electron embed has the same
    // default — prefs loader falls back to codex when no pref is set).
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; ok: boolean };
    expect(typeof body.kind === "string" && body.kind.length > 0).toBeTruthy();
    expect(body.ok).toBeTypeOf("boolean");
  });

  test("agents status is reachable and lists every registered runner", async () => {
    const res = await fetch(`${handle.url}/centraid/_agents/status`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    // Which CLIs show available depends on what's on the test host's PATH — we
    // only assert the route is mounted and returns a well-shaped snapshot (the
    // gateway probes its own host).
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<{
        kind: string;
        label: string;
        available: boolean;
        minVersion: string;
      }>;
    };
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.length).toBeGreaterThan(0);
    for (const agent of body.agents) {
      expect(agent.kind).toBeTypeOf("string");
      expect(agent.label).toBeTypeOf("string");
      expect(agent.available).toBeTypeOf("boolean");
      expect(agent.minVersion).toBeTypeOf("string");
    }
  });

  test("rejects /centraid/_agents/status without the bearer token", async () => {
    const res = await fetch(`${handle.url}/centraid/_agents/status`);
    expect(res.status).toBe(401);
  });

  test("rejects /centraid/_gateway/diagnostics without the bearer token — same gate as /_gateway/health", async () => {
    const [diagnostics, health] = await Promise.all([
      fetch(`${handle.url}/centraid/_gateway/diagnostics`),
      fetch(`${handle.url}/centraid/_gateway/health`),
    ]);
    expect(diagnostics.status).toBe(401);
    expect(diagnostics.status).toBe(health.status);
  });

  test("serves a diagnostics bundle when the bearer token matches", async () => {
    const res = await fetch(`${handle.url}/centraid/_gateway/diagnostics`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gateway: { version: string; schemaEpoch: number };
      runtime: { platform: string; arch: string; nodeVersion: string };
      health: { status: string };
      logs: unknown[];
      vaults: Array<{
        vaultId: string;
        name: string;
        files: Record<string, number | null>;
      }>;
      config: unknown;
    };
    expect(body.gateway.version).toBeTypeOf("string");
    expect(body.gateway.schemaEpoch).toBeTypeOf("number");
    expect(body.runtime.nodeVersion).toBe(process.version);
    expect(body.health.status).toStrictEqual(expect.any(String));
    expect(Array.isArray(body.logs)).toBe(true);
    // Both auto-founded vaults are mounted, sized off vault.db/journal.db.
    expect(body.vaults).toHaveLength(2);
    // The diagnostics inventory enumerates planes in FOUNDING order (Shared
    // leads) — unlike the client-facing listing, which leads with the default
    // vault (#665). Nothing here reads element 0 as "primary".
    expect(body.vaults[0]!.vaultId).toBe(
      handle.vaults.planesList()[0]!.boot.vaultId
    );
    expect(body.vaults[0]!.files.vaultDbBytes).toBeTypeOf("number");
  });

  test("diagnostics config never leaks a secret-shaped value from the bearer token itself", async () => {
    // The gateway's own bearer token is the most obvious secret already in
    // process — prove the diagnostics bundle never echoes it back verbatim.
    const res = await fetch(`${handle.url}/centraid/_gateway/diagnostics`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    const raw = await res.text();
    expect(raw).not.toContain(handle.token);
  });

  test("rejects /centraid/_gateway/backup without the bearer token — same gate as /_gateway/health", async () => {
    const [backup, health] = await Promise.all([
      fetch(`${handle.url}/centraid/_gateway/backup`),
      fetch(`${handle.url}/centraid/_gateway/health`),
    ]);
    expect(backup.status).toBe(401);
    expect(backup.status).toBe(health.status);
  });

  test("reports an unconfigured destination for the default vault when no backup block is set", async () => {
    const res = await fetch(`${handle.url}/centraid/_gateway/backup`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      vaults: Array<Record<string, unknown>>;
      recoveryKit: { confirmedAt: number | null };
    };
    // recoveryKit (issue #351 wave 4) reads "never confirmed" — there's no
    // BackupService (and so no state.json) to have recorded a confirmation.
    // The status surface still inventories the active vault so the UI can show
    // its local-only destination and policy before backup is configured.
    expect(body).toMatchObject({
      configured: false,
      recoveryKit: { confirmedAt: null },
    });
    expect(body.vaults).toHaveLength(2);
    // Backup inventories planes in FOUNDING order, so Shared leads here even
    // though the client-facing vault listing leads with Personal (#665).
    expect(body.vaults[0]).toMatchObject({
      vaultId: handle.vaults.planesList()[0]!.boot.vaultId,
      name: "Shared",
      running: false,
      destination: { kind: "gateway-local" },
      pendingOffsite: { count: 0, bytes: 0 },
    });
  });

  test("POST /centraid/_gateway/backup/run refuses with a clear body when not configured", async () => {
    const res = await fetch(`${handle.url}/centraid/_gateway/backup/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_configured");
  });

  test("backup status/run round-trip when backup IS configured", async () => {
    await handle.close();
    const providerDir = await tempDir("backup-provider-");
    handle = await serve({
      paths: pathsUnder(dataDir),
      backup: {
        enabled: true,
        provider: { kind: "local", dir: providerDir },
      },
    });
    // Backup status inventories planes in FOUNDING order, so this is Shared —
    // the registry DEFAULT (`current()`, and the head of the client-facing
    // listing since #665) is Personal.
    const vaultId = handle.vaults.planesList()[0]!.boot.vaultId;
    const auth = { Authorization: `Bearer ${handle.token}` };

    const before = await fetch(`${handle.url}/centraid/_gateway/backup`, {
      headers: auth,
    });
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      configured: boolean;
      vaults: Array<{
        vaultId: string;
        name?: string;
        lastBackupAt?: string;
        running?: boolean;
      }>;
    };
    expect(beforeBody.configured).toBe(true);
    expect(beforeBody.vaults).toHaveLength(2);
    expect(beforeBody.vaults[0]).toMatchObject({ vaultId, running: false });
    expect(beforeBody.vaults[0]?.lastBackupAt).toBeUndefined();

    // Reading status begins the recovery-kit ceremony. Export, re-select, and
    // verify the exact password-wrapped artifact before backup mutations.
    await verifyCurrentRecoveryKit(handle, auth);

    const run = await fetch(`${handle.url}/centraid/_gateway/backup/run`, {
      method: "POST",
      headers: auth,
    });
    expect(run.status).toBe(202);
    const runBody = (await run.json()) as { accepted: boolean };
    expect(runBody.accepted).toBe(true);

    // The run happens in the background — poll until it lands (bounded).
    // Creating the first target intentionally stales the just-confirmed kit.
    // Ordinary staleness is a re-download prompt, not a gateway outage; observe
    // completion through the returned host-side service handle.
    let lastBackupAt: string | undefined;
    const awaitBackup = async (remaining: number): Promise<void> => {
      const poll = await handle.backup!.status();
      lastBackupAt = poll[vaultId]?.lastBackupAt;
      if (lastBackupAt || remaining === 0) return;
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      return awaitBackup(remaining - 1);
    };
    await awaitBackup(50);
    expect(lastBackupAt).toBeTruthy();
  });

  test("recoveryKit confirmation survives a restart (issue #351 wave 4)", async () => {
    // Real end-to-end: real HTTP server, real BackupService, real gateway.db
    // on disk — `handle.close()` + a fresh `serve()` over the SAME dataDir is
    // as close to "the gateway process restarted" as a unit test gets short
    // of actually spawning a second process.
    await handle.close();
    const providerDir = await tempDir("backup-provider-");
    const backupConfig = {
      enabled: true as const,
      provider: { kind: "local" as const, dir: providerDir },
    };
    handle = await serve({
      paths: pathsUnder(dataDir),
      backup: backupConfig,
    });
    const auth = { Authorization: `Bearer ${handle.token}` };

    const before = await fetch(`${handle.url}/centraid/_gateway/backup`, {
      headers: auth,
    });
    const beforeBody = (await before.json()) as {
      recoveryKit: { confirmedAt: number | null; kitFingerprint?: string };
    };
    expect(beforeBody.recoveryKit).toMatchObject({
      confirmedAt: null,
      kitFingerprint: expect.any(String),
    });

    const confirmBody = await verifyCurrentRecoveryKit(handle, auth);
    expect(confirmBody.confirmedAt).toBeGreaterThan(0);

    // Restart: close this instance, boot a fresh one over the identical
    // on-disk dataDir (same gateway.db recovery-kit row).
    await handle.close();
    handle = await serve({
      paths: pathsUnder(dataDir),
      backup: backupConfig,
    });
    const authAfter = { Authorization: `Bearer ${handle.token}` }; // token is re-minted per boot

    const after = await fetch(`${handle.url}/centraid/_gateway/backup`, {
      headers: authAfter,
    });
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as {
      recoveryKit: { confirmedAt: number | null; kitFingerprint?: string };
    };
    expect(afterBody.recoveryKit).toMatchObject({
      confirmedAt: confirmBody.confirmedAt,
      kitFingerprint: expect.any(String),
    });
  });
});
