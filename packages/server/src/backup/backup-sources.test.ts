import { randomBytes, createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { ReplicaIndex } from "@centraid/vault";

import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { run } from "../worktree-store/git.js";
import { WorktreeStore } from "../worktree-store/worktree-store.js";
import { assembleSourceEntries } from "./backup-sources.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];
describe("backup-sources", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });
  async function openPlane(): Promise<VaultPlane> {
    const dir = await tempDir("backup-sources-vault");
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());
    return plane;
  }

  function capturingLogger(): {
    info: string[];
    warn: string[];
    log: { info: (m: string) => void; warn: (m: string) => void };
  } {
    const info: string[] = [];
    const warn: string[] = [];
    return {
      info,
      warn,
      log: {
        info: (m: string) => void info.push(m),
        warn: (m: string) => void warn.push(m),
      },
    };
  }

  const PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

  function stageAndAttachBigBlob(
    plane: VaultPlane,
    subjectId: string,
    bytes: Buffer
  ): string {
    const staged = plane.gateway.stageBlob(plane.ownerCredential, {
      bytes,
      mediaType: "application/octet-stream",
      filename: "big.bin",
    });
    const out = plane.gateway.invoke(plane.ownerCredential, {
      command: "core.attach",
      input: {
        subject_type: "schedule.task",
        subject_id: subjectId,
        staged_sha: staged.sha256,
      },
    });
    if (out.status !== "executed")
      throw new Error(`attach failed: ${JSON.stringify(out)}`);
    return staged.sha256;
  }

  function addTask(plane: VaultPlane, title: string): string {
    const out = plane.gateway.invoke(plane.ownerCredential, {
      command: "schedule.add_task",
      input: { title },
    });
    if (out.status !== "executed")
      throw new Error(`add_task failed: ${JSON.stringify(out)}`);
    return (out as { output: { task_id: string } }).output.task_id;
  }

  async function publishRealApp(
    plane: VaultPlane,
    appId: string
  ): Promise<void> {
    const store = new WorktreeStore({ root: plane.codeStoreRoot });
    await store.init();
    const session = await store.openSession("s1");
    const appDir = path.join(session.worktreePath, "apps", appId);
    await fs.mkdir(path.join(appDir, "actions"), { recursive: true });
    await fs.writeFile(
      path.join(appDir, "app.json"),
      JSON.stringify({ id: appId, name: appId }, null, 2)
    );
    await fs.writeFile(
      path.join(appDir, "actions", "noop.js"),
      "export default async () => ({ status: 200, body: {} });\n"
    );
    await store.publish({ sessionId: "s1", appId, message: "v1" });
    await store.closeSession("s1");
  }

  function sha256Of(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  test("a fresh vault (no blobs, no code store, nothing sealed) yields only the two staged DB entries", async () => {
    const plane = await openPlane();
    const bundleDir = await tempDir("backup-sources-bundle");
    const captured = capturingLogger();

    plane.walTick();
    const entries = await assembleSourceEntries({
      plane,
      bundleDir,
      log: captured.log,
    });

    expect(entries.map((e) => e.kind)).toStrictEqual(["db", "db"]);
    expect(entries.map((e) => e.path)).toStrictEqual([
      "vault.db",
      "journal.db",
    ]);
    // Key FILE is minted on first open; the fingerprint stamp is the real "ever sealed" signal — no stamp, no seal-key entry.
    expect(entries.some((e) => e.kind === "seal-key")).toBe(false);
    expect(
      captured.info.some((m) => m.includes("no code store bare repo yet"))
    ).toBe(true);

    entries.forEach((entry) => {
      const db = new DatabaseSync(entry.absolutePath, { readOnly: true });
      try {
        const row = db
          .prepare("SELECT count(*) AS n FROM sqlite_master")
          .get() as { n: number };
        expect(row.n).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });
    const vaultCopy = new DatabaseSync(entries[0]!.absolutePath, {
      readOnly: true,
    });
    try {
      const row = vaultCopy
        .prepare("SELECT count(*) AS n FROM core_vault")
        .get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      vaultCopy.close();
    }
  });

  test(
    "a vault with real blobs, a real published app, and a real sealed value " +
      "yields entries in FORMAT.md order: db, db, blobs…, git-bundle",
    async () => {
      const plane = await openPlane();
      const bundleDir = await tempDir("backup-sources-bundle");

      const taskId = addTask(plane, "Frame the print");
      const inlineOut = plane.gateway.invoke(plane.ownerCredential, {
        command: "core.attach",
        input: {
          subject_type: "schedule.task",
          subject_id: taskId,
          data_uri: PNG,
        },
      });
      if (inlineOut.status !== "executed")
        throw new Error("inline attach failed");
      const inlineContentId = (inlineOut as { output: { content_id: string } })
        .output.content_id;
      const inlineSha = (
        plane.db.vault
          .prepare(
            "SELECT content_uri FROM core_content_item WHERE content_id = ?"
          )
          .get(inlineContentId) as { content_uri: string }
      ).content_uri.slice("blob:sha256-".length);

      const bigBytes = randomBytes(1_500_000);
      const bigSha = stageAndAttachBigBlob(plane, taskId, bigBytes);
      expect(bigSha).toBe(sha256Of(bigBytes));

      await publishRealApp(plane, "todo");

      const lockerOut = plane.gateway.invoke(plane.ownerCredential, {
        command: "locker.add_item",
        input: {
          type: "login",
          title: "GitHub",
          username: "priya",
          password: "H2$kL9mVq!pR4wZ",
        },
      });
      if (lockerOut.status !== "executed")
        throw new Error("locker.add_item failed");

      plane.walTick();
      const entries = await assembleSourceEntries({
        plane,
        bundleDir,
        log: silentLogger,
      });

      expect(entries.map((e) => e.kind)).toStrictEqual([
        "db",
        "db",
        "blob",
        "blob",
        "git-bundle",
      ]);
      // Blob paths sort by path (deterministic manifests), not insertion order — random sha is not stable across runs.
      const smallBlobPath = `blobs/sha256/${inlineSha.slice(0, 2)}/${inlineSha}`;
      const bigBlobPath = `blobs/sha256/${bigSha.slice(0, 2)}/${bigSha}`;
      const expectedBlobPaths = [smallBlobPath, bigBlobPath].sort((a, b) =>
        a.localeCompare(b)
      );
      expect(entries.map((e) => e.path)).toStrictEqual([
        "vault.db",
        "journal.db",
        ...expectedBlobPaths,
        "apps.bundle",
      ]);

      const vaultCopy = new DatabaseSync(entries[0]!.absolutePath, {
        readOnly: true,
      });
      try {
        const row = vaultCopy
          .prepare("SELECT count(*) AS n FROM locker_item")
          .get() as {
          n: number;
        };
        expect(row.n).toBe(1);
      } finally {
        vaultCopy.close();
      }

      const smallBlobEntry = entries.find((e) => e.path === smallBlobPath)!;
      const bigBlobEntry = entries.find((e) => e.path === bigBlobPath)!;
      expect(path.basename(smallBlobEntry.absolutePath)).toBe(inlineSha);
      expect(sha256Of(await fs.readFile(smallBlobEntry.absolutePath))).toBe(
        inlineSha
      );
      expect(path.basename(bigBlobEntry.absolutePath)).toBe(bigSha);
      const bigOnDisk = await fs.readFile(bigBlobEntry.absolutePath);
      expect(bigOnDisk.equals(bigBytes)).toBe(true);
      // CAS in place — never duplicated into the bundle dir.
      expect(smallBlobEntry.absolutePath.startsWith(plane.dir)).toBe(true);
      expect(smallBlobEntry.absolutePath.startsWith(bundleDir)).toBe(false);

      // `git bundle verify` needs a repo context — run against the bare repo (full `--all` bundle has no prerequisites).
      const bundleEntry = entries[4]!;
      const bareRepoDir = path.join(plane.codeStoreRoot, "apps.git");
      await expect(
        run(["bundle", "verify", bundleEntry.absolutePath], {
          cwd: bareRepoDir,
        })
      ).resolves.toBeTruthy();
      const cloneDir = await tempDir("backup-sources-clone");
      await run(["clone", "--quiet", bundleEntry.absolutePath, cloneDir], {
        cwd: bundleDir,
      });
      const appJson = JSON.parse(
        await fs.readFile(
          path.join(cloneDir, "apps", "todo", "app.json"),
          "utf8"
        )
      ) as { id: string };
      expect(appJson.id).toBe("todo");

      expect(entries.some((entry) => entry.kind === "seal-key")).toBe(false);
    }
  );

  test("a remote-primary snapshot carries only durable pending-offsite outbox blobs", async () => {
    const plane = await openPlane();
    const bundleDir = await tempDir("backup-sources-remote-primary");
    const settingsRow = plane.db.vault
      .prepare("SELECT settings_json FROM core_vault LIMIT 1")
      .get() as { settings_json: string | null };
    const settings = settingsRow.settings_json
      ? (JSON.parse(settingsRow.settings_json) as object)
      : {};
    plane.db.vault.prepare("UPDATE core_vault SET settings_json = ?").run(
      JSON.stringify({
        ...settings,
        blob_store: {
          kind: "s3",
          endpoint: "https://storage.invalid",
          bucket: "remote-primary-test",
        },
      })
    );

    const taskId = addTask(plane, "Protect only transit bytes");
    const pendingBytes = randomBytes(128 * 1024);
    const remoteBytes = randomBytes(96 * 1024);
    const pendingSha = stageAndAttachBigBlob(plane, taskId, pendingBytes);
    const remoteSha = stageAndAttachBigBlob(plane, taskId, remoteBytes);
    expect(plane.db.blobTransfers.pendingSnapshotShas()).toStrictEqual(
      expect.arrayContaining([pendingSha, remoteSha])
    );

    // HEAD-confirmed: local file stays resident, durable outbox no longer treats it as snapshot material.
    plane.db.blobTransfers.state.completeOutbox(remoteSha);
    new ReplicaIndex(plane.db.vault).mark(remoteSha, remoteBytes.length);
    plane.walTick();
    const entries = await assembleSourceEntries({
      plane,
      bundleDir,
      log: silentLogger,
    });
    const blobPaths = entries
      .filter((entry) => entry.kind === "blob")
      .map((entry) => entry.path);

    expect(blobPaths).toStrictEqual([
      `blobs/sha256/${pendingSha.slice(0, 2)}/${pendingSha}`,
    ]);
    expect(blobPaths.some((entry) => entry.endsWith(remoteSha))).toBe(false);
  });

  test("db bases are the shipper pinned clones read IN PLACE, and assembly writes nothing when there is no code store", async () => {
    const plane = await openPlane();
    const bundleDir = await tempDir("backup-sources-bundle");

    // #408: db entries read the WAL shipper's pinned bases IN PLACE (`wal-ship/bases`), never copies. No code store → assembly writes nothing, and re-running accumulates nothing.
    plane.walTick();
    const first = await assembleSourceEntries({
      plane,
      bundleDir,
      log: silentLogger,
    });
    expect(first.map((e) => e.path)).toStrictEqual(["vault.db", "journal.db"]);

    const second = await assembleSourceEntries({
      plane,
      bundleDir,
      log: silentLogger,
    });
    expect(second.map((e) => e.path)).toStrictEqual(["vault.db", "journal.db"]);
    await expect(fs.readdir(bundleDir)).resolves.toStrictEqual([]);
    for (const entry of second) {
      expect(entry.absolutePath).toContain(path.join("wal-ship", "bases"));
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(entry.walGeneration).toMatch(/^[0-9a-f]{32}$/u);
      expect(entry.baseTickMs).toBeGreaterThan(0);
    }
    expect(second[0]!.baseTickMs).toBe(second[1]!.baseTickMs);
  });

  test("assembly REFUSES an uncoordinated base pair rather than registering it", async () => {
    const plane = await openPlane();
    const bundleDir = await tempDir("backup-sources-bundle");
    plane.walTick();

    // Two bases from two ticks — no coordinated restore point (newer base holds receipts for rows that live only in the older one's SEGMENTS). Assert here regardless of the shipper's own generation pairing.
    const shipper = plane.walShipper!;
    const real = shipper.currentBases.bind(shipper);
    shipper.currentBases = () => {
      const bases = real();
      return bases.map((b, i) =>
        i === 0 ? { ...b, createdAtMs: b.createdAtMs + 60_000 } : b
      );
    };
    await expect(
      assembleSourceEntries({ plane, bundleDir, log: silentLogger })
    ).rejects.toThrow(/bases are from different ticks/u);
    shipper.currentBases = real;
  });

  test("the code-store bundle is REUSED untouched while refs are unchanged, and REGENERATED when they move", async () => {
    const plane = await openPlane();
    const bundleDir = await tempDir("backup-sources-bundle");
    await publishRealApp(plane, "todo");

    plane.walTick();
    const first = capturingLogger();
    const e1 = await assembleSourceEntries({
      plane,
      bundleDir,
      log: first.log,
    });
    const bundle1 = e1.find((e) => e.kind === "git-bundle")!;
    expect(bundle1.absolutePath).toBe(path.join(bundleDir, "apps.bundle"));
    const digest1 = await fs.readFile(
      path.join(bundleDir, "apps.bundle.refs"),
      "utf8"
    );
    const mtime1 = (await fs.stat(bundle1.absolutePath)).mtimeMs;

    // Same refs → reuse UNTOUCHED (mtime is the fast-path key). A fresh `git bundle create` would have moved mtime.
    const second = capturingLogger();
    const e2 = await assembleSourceEntries({
      plane,
      bundleDir,
      log: second.log,
    });
    const bundle2 = e2.find((e) => e.kind === "git-bundle")!;
    expect(bundle2.absolutePath).toBe(bundle1.absolutePath);
    expect((await fs.stat(bundle2.absolutePath)).mtimeMs).toBe(mtime1);
    expect(second.info.some((m) => m.includes("reusing apps.bundle"))).toBe(
      true
    );

    await publishRealApp(plane, "todo2");
    const e3 = await assembleSourceEntries({
      plane,
      bundleDir,
      log: silentLogger,
    });
    const bundle3 = e3.find((e) => e.kind === "git-bundle")!;
    const digest3 = await fs.readFile(
      path.join(bundleDir, "apps.bundle.refs"),
      "utf8"
    );
    expect(digest3).not.toBe(digest1);
    const cloneDir = await tempDir("backup-sources-clone-2");
    await run(["clone", "--quiet", bundle3.absolutePath, cloneDir], {
      cwd: bundleDir,
    });
    expect(existsSync(path.join(cloneDir, "apps", "todo", "app.json"))).toBe(
      true
    );
    expect(existsSync(path.join(cloneDir, "apps", "todo2", "app.json"))).toBe(
      true
    );
  });
});
