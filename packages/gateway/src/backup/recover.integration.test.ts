import crypto, { randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  BackupProviderError,
  openRemoteBackupProvider,
  SNAPSHOT_FORMAT_V2,
  wrapRecoveryKit,
} from "@centraid/backup";
import type { WrappedRecoveryKitDocument } from "@centraid/backup";
import { startFakeProviderServer } from "@centraid/backup/dist/testing/fake-provider-server.js";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { FsBlobStore, KeyStore, ReplicaIndex } from "@centraid/vault";

import { daemonLayoutFor } from "../cli/paths.js";
import { HealthRegistry } from "../serve/health-registry.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { openVaultRegistry } from "../serve/vault-registry.js";
import { run } from "../worktree-store/git.js";
import { WorktreeStore } from "../worktree-store/worktree-store.js";
import { BackupService } from "./backup-service.js";
import { recover } from "./recover.js";

vi.setConfig({ testTimeout: 30_000 });

const KIT_PASSWORD = "correct horse battery staple";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];
describe("backup/recover", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });
  function invoke(
    plane: VaultPlane,
    command: string,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    const out = plane.gateway.invoke(plane.ownerCredential, { command, input });
    if (out.status !== "executed")
      throw new Error(`${command} failed: ${JSON.stringify(out)}`);
    return (out as { output: Record<string, unknown> }).output;
  }

  function stage(plane: VaultPlane, bytes: Buffer, name: string): string {
    return plane.gateway.stageBlob(plane.ownerCredential, {
      bytes,
      mediaType: "application/octet-stream",
      filename: name,
    }).sha256;
  }

  function seedSealedOutbox(plane: VaultPlane): {
    itemId: string;
    grantId: string;
  } {
    invoke(plane, "sync.configure_credential", {
      kind: "pull.gmail",
      label: "personal",
      cred_kind: "api_key",
      api_key: "sk-recover-test",
      allowed_hosts: ["gmail.googleapis.com"],
    });
    const itemId = invoke(plane, "outbox.stage", {
      kind: "pull.gmail",
      label: "personal",
      verb: "gmail.send",
      target: "ravi@example.com",
      artifact: { to: "ravi@example.com", subject: "Hi", body: "See you." },
      request: {
        method: "POST",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        headers: { authorization: "Bearer {{connection:api_key}}" },
        body: '{"raw":"x"}',
      },
    })["item_id"] as string;
    const grantId = crypto.randomUUID();
    plane.db.vault
      .prepare(
        `INSERT INTO outbox_grant (grant_id, actor_id, verb, target, created_at, revoked_at)
       VALUES (?, 'owner', 'gmail.send', 'ravi@example.com', ?, NULL)`
      )
      .run(grantId, new Date().toISOString());
    plane.db.vault
      .prepare(
        `UPDATE outbox_item SET status = 'approved', decided_at = ?, grant_id = ? WHERE item_id = ?`
      )
      .run(new Date().toISOString(), grantId, itemId);
    return { itemId, grantId };
  }

  interface MachineA {
    vaultId: string;
    targetId: string;
    oldGeneration: number;
    kitDocument: WrappedRecoveryKitDocument;
    originals: string[];
    thumbs: string[];
    itemId: string;
    grantId: string;
    appId: string;
    serverUrl: string;
    apiKey: string;
    peoplePartyId: string;
    peopleRevisionId: string;
    receiptExpenseId: string;
    receiptId: string;
    sourceSealKeyDestroyed: boolean;
  }

  async function publishSeedApp(plane: VaultPlane): Promise<string> {
    const appId = "todo";
    const store = new WorktreeStore({ root: plane.codeStoreRoot });
    await store.init();
    const session = await store.openSession("seed-session");
    const appDir = path.join(session.worktreePath, "apps", appId);
    await fs.mkdir(path.join(appDir, "actions"), { recursive: true });
    await fs.writeFile(
      path.join(appDir, "app.json"),
      JSON.stringify({ id: appId, name: "Todo" }, null, 2)
    );
    await fs.writeFile(path.join(appDir, "index.html"), "<h1>Todo</h1>\n");
    await store.publish({
      sessionId: "seed-session",
      appId,
      message: "seed v1",
    });
    await store.closeSession("seed-session");
    return appId;
  }

  async function seedMachineA(
    server: Awaited<ReturnType<typeof startFakeProviderServer>>
  ): Promise<MachineA> {
    const vaultRoot = await tempDir("recover-a-vault");
    const backupDir = await tempDir("recover-a-backup");
    const registry = openVaultRegistry({
      rootDir: vaultRoot,
      logger: silentLogger,
      ownerName: "Mara",
    });
    cleanups.push(() => registry.stop());
    registry.create("Mara's vault");
    const vaultId = registry.defaultVaultId();
    const plane = registry.get(vaultId)!;
    const service = new BackupService({
      config: {
        enabled: true,
        provider: {
          kind: "remote",
          endpoint: server.url,
          apiKey: server.apiKey,
        },
      },
      cacheDir: backupDir,
      keyStore: new KeyStore(path.join(vaultRoot, "keys")),
      vaults: registry,
      health: new HealthRegistry(),
      logger: silentLogger,
    });
    cleanups.push(() => service.stop());

    const originals: string[] = [];
    const thumbs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const taskId = invoke(plane, "schedule.add_task", {
        title: `Photo ${i}`,
      })["task_id"] as string;
      const originalSha = stage(plane, randomBytes(400 + i), `photo-${i}.bin`);
      const attach = invoke(plane, "core.attach", {
        subject_type: "schedule.task",
        subject_id: taskId,
        staged_sha: originalSha,
      });
      originals.push(originalSha);
      const thumbBytes = randomBytes(64 + i);
      const thumbSha = stage(plane, thumbBytes, `photo-${i}.thumb`);
      plane.db.vault
        .prepare(
          `INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, 'thumb', ?, 'image/webp', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          attach["content_id"] as string,
          thumbSha,
          thumbBytes.length,
          new Date().toISOString()
        );
      thumbs.push(thumbSha);
    }

    const { itemId, grantId } = seedSealedOutbox(plane);

    // #630 P5 restore-after-erase canary: preserve both the new lifecycle
    // columns and their durable pre-trash snapshot through kit/provider
    // recovery after the source DEK file is destroyed.
    const peoplePartyId = invoke(plane, "people.add_person", {
      display_name: "Maya Chen",
      role: "Design lead",
      cadence_days: 14,
    })["party_id"] as string;
    const peopleRevisionId = invoke(plane, "people.trash_person", {
      party_id: peoplePartyId,
    })["revision_id"] as string;
    const ownerPartyId = (
      plane.db.vault
        .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
        .get() as { owner_party_id: string }
    ).owner_party_id;
    const receiptGroupId = invoke(plane, "tally.create_group", {
      name: "Recovery receipt",
      icon: "🧾",
      member_ids: [],
    })["group_id"] as string;
    const receiptOutput = invoke(plane, "tally.add_receipt_expense", {
      group_id: receiptGroupId,
      description: "Recovery dinner",
      amount_minor: 1_200,
      paid_by: ownerPartyId,
      category: "food",
      splits: [{ party_id: ownerPartyId, share_minor: 1_200 }],
      staged_sha: stage(
        plane,
        Buffer.from("receipt-recovery-canary"),
        "receipt.jpg"
      ),
      ocr_text: "Dinner 10.00\nTax 2.00",
      line_items: [
        {
          kind: "item",
          description: "Dinner",
          amount_minor: 1_000,
          allocations: [{ party_id: ownerPartyId, share_minor: 1_000 }],
        },
        {
          kind: "tax",
          description: "Tax",
          amount_minor: 200,
          allocations: [{ party_id: ownerPartyId, share_minor: 200 }],
        },
      ],
    });

    const appId = await publishSeedApp(plane);

    const replica = new ReplicaIndex(plane.db.vault);
    replica.mark(originals[0]!, 400, "cas");
    replica.mark(originals[1]!, 401, "cas");

    await service.runBackup(vaultId);
    const status = await service.status();
    const targetId = status[vaultId]!.targetId;
    const oldGeneration = status[vaultId]!.generation;
    const kitDocument = wrapRecoveryKit(
      await service.recoveryKitDocument(),
      KIT_PASSWORD
    );
    const sourceSealKeyDestroyed = new KeyStore(
      path.join(vaultRoot, "keys")
    ).destroy(`${vaultId}.sealkey`);

    const casProvider = openRemoteBackupProvider({
      baseUrl: server.url,
      apiKey: server.apiKey,
    });
    const casStore = await casProvider.openDataPlane(
      targetId,
      "cas",
      "read-write"
    );
    await Promise.all(
      [originals[0]!, originals[1]!].map((sha) =>
        casStore.put(
          `blobs/sha256/${sha}`,
          new Uint8Array(Buffer.from(`remote-${sha}`))
        )
      )
    );

    return {
      vaultId,
      targetId,
      oldGeneration,
      kitDocument,
      originals,
      thumbs,
      itemId,
      grantId,
      appId,
      serverUrl: server.url,
      apiKey: server.apiKey,
      peoplePartyId,
      peopleRevisionId,
      receiptExpenseId: receiptOutput["expense_id"] as string,
      receiptId: receiptOutput["receipt_id"] as string,
      sourceSealKeyDestroyed,
    };
  }

  test("a blank machine recovers a whole vault from nothing but the kit and the api-key", async () => {
    const server = await startFakeProviderServer();
    cleanups.push(() => server.close());
    const a = await seedMachineA(server);
    expect(a.oldGeneration).toBe(1);
    expect(a.sourceSealKeyDestroyed).toBe(true);

    const dataDir = await tempDir("recover-blank");
    const layout = daemonLayoutFor(dataDir);
    const report = await recover({
      kitDocument: a.kitDocument,
      password: KIT_PASSWORD,
      apiKey: a.apiKey,
      vaultRoot: layout.vaultDir,
      dataDir: layout.dataDir,
      log: silentLogger,
    });

    const vaultDir = path.join(layout.vaultDir, a.vaultId);
    expect(report.vaultDir).toBe(vaultDir);
    expect(existsSync(path.join(vaultDir, "vault.db"))).toBe(true);
    expect(existsSync(path.join(vaultDir, "journal.db"))).toBe(true);
    const restoredDb = new DatabaseSync(path.join(vaultDir, "vault.db"), {
      readOnly: true,
    });
    try {
      expect(
        (
          restoredDb
            .prepare("SELECT COUNT(*) AS n FROM schedule_task")
            .get() as { n: number }
        ).n
      ).toBe(3);
      const restoredPerson = restoredDb
        .prepare(
          `SELECT pr.role, pr.deleted_at, pr.purge_at, r.operation,
                  r.entity_type, r.entity_id, r.snapshot_json
             FROM people_profile pr
             JOIN core_entity_revision r
               ON r.revision_id = ?
            WHERE pr.party_id = ?`
        )
        .get(a.peopleRevisionId, a.peoplePartyId) as {
        role: string;
        deleted_at: string | null;
        purge_at: string | null;
        operation: string;
        entity_type: string;
        entity_id: string;
        snapshot_json: string;
      };
      expect(restoredPerson).toMatchObject({
        role: "Design lead",
        operation: "trash",
        entity_type: "people.person",
        entity_id: a.peoplePartyId,
      });
      expect(restoredPerson.deleted_at).not.toBeNull();
      expect(restoredPerson.purge_at).not.toBeNull();
      expect(JSON.parse(restoredPerson.snapshot_json)).toMatchObject({
        role: "Design lead",
        deleted_at: null,
        purge_at: null,
      });
      expect(
        restoredDb
          .prepare(
            `SELECT r.expense_id, d.text_content,
                    count(DISTINCT l.line_item_id) AS line_count,
                    count(a.party_id) AS allocation_count
               FROM tally_expense_receipt r
               JOIN core_content_derivative d
                 ON d.content_id = r.content_id AND d.variant = 'text'
               JOIN tally_expense_line_item l ON l.receipt_id = r.receipt_id
               JOIN tally_expense_line_allocation a
                 ON a.line_item_id = l.line_item_id
              WHERE r.receipt_id = ?
              GROUP BY r.expense_id, d.text_content`
          )
          .get(a.receiptId)
      ).toMatchObject({
        expense_id: a.receiptExpenseId,
        text_content: "Dinner 10.00\nTax 2.00",
        line_count: 2,
        allocation_count: 2,
      });
      expect(
        restoredDb
          .prepare(
            `SELECT role, is_primary FROM core_attachment
              WHERE target_type = 'tally.expense' AND target_id = ?`
          )
          .get(a.receiptExpenseId)
      ).toMatchObject({ role: "receipt", is_primary: 1 });
    } finally {
      restoredDb.close();
    }

    expect(report.inventoryConsulted).toBe(true);
    expect(report.skippedBlobs).toBe(2);
    const restoredBlobs = new FsBlobStore(path.join(vaultDir, "blobs"));
    expect(restoredBlobs.hasSync(a.originals[0]!)).toBe(false); // remote holds it ⇒ deferred
    expect(restoredBlobs.hasSync(a.originals[1]!)).toBe(false);
    expect(restoredBlobs.hasSync(a.originals[2]!)).toBe(true); // snapshot-only ⇒ materialized
    for (const thumb of a.thumbs)
      expect(restoredBlobs.hasSync(thumb)).toBe(true);

    expect(existsSync(path.join(layout.keysDir, `${a.vaultId}.sealkey`))).toBe(
      true
    );

    const bareDir = path.join(vaultDir, "code", "apps.git");
    expect(existsSync(path.join(bareDir, "HEAD"))).toBe(true);
    expect(existsSync(path.join(vaultDir, "apps.bundle"))).toBe(false);
    const tags = await run(["tag", "--list"], { cwd: bareDir });
    expect(tags.split("\n")).toContain(`${a.appId}/v1`);
    const recoveredStore = new WorktreeStore({
      root: path.join(vaultDir, "code"),
    });
    await recoveredStore.init();
    await expect(recoveredStore.listApps()).resolves.toStrictEqual([a.appId]);

    expect(existsSync(path.join(vaultDir, "RESTORE_QUARANTINE.json"))).toBe(
      true
    );
    expect(report.quarantine).toContain("outbox");
    const mounted = openVaultRegistry({
      rootDir: layout.vaultDir,
      logger: silentLogger,
      enableWalShipper: false,
    });
    cleanups.push(() => mounted.stop());
    const mountedPlane = mounted.get(a.vaultId)!;
    expect(mountedPlane.quarantine).not.toBeNull();
    expect(mountedPlane.quarantine!.outboxParked).toBeGreaterThanOrEqual(1);
    expect(mountedPlane.quarantine!.outboxGrantsRevoked).toBeGreaterThanOrEqual(
      1
    );
    const item = mountedPlane.db.vault
      .prepare("SELECT status FROM outbox_item WHERE item_id = ?")
      .get(a.itemId) as { status: string };
    expect(item.status).toBe("pending"); // approved → parked back to pending
    const grant = mountedPlane.db.vault
      .prepare("SELECT revoked_at FROM outbox_grant WHERE grant_id = ?")
      .get(a.grantId) as { revoked_at: string | null };
    expect(grant.revoked_at).not.toBeNull();

    const gatewayDb = new DatabaseSync(layout.gatewayDbFile, {
      readOnly: true,
    });
    const targetState = gatewayDb
      .prepare("SELECT config_json FROM backup_targets WHERE vault_id = ?")
      .get(a.vaultId) as { config_json: string };
    gatewayDb.close();
    const recoveredTarget = JSON.parse(targetState.config_json) as {
      generation: number;
      lastSeq: number;
    };
    expect(recoveredTarget.generation).toBe(a.oldGeneration + 1);
    expect(recoveredTarget.lastSeq).toBe(report.seq);
    expect(report.generation).toBe(a.oldGeneration + 1);
    expect(new KeyStore(layout.keysDir).export("keyring.key")).not.toBeNull();

    const providerClient = openRemoteBackupProvider({
      baseUrl: a.serverUrl,
      apiKey: a.apiKey,
    });
    await providerClient.registerSnapshot(a.targetId, {
      idempotencyKey: "recovered-first",
      manifestKey: `u/${a.targetId}/backup/manifests/recovered.json`,
      manifestHash: "a".repeat(64),
      totalBytes: 0,
      objectCount: 0,
      generation: report.generation,
      format: SNAPSHOT_FORMAT_V2,
      appMeta: {},
    });
    let fenced = false;
    try {
      await providerClient.registerSnapshot(a.targetId, {
        idempotencyKey: "old-machine-next",
        manifestKey: `u/${a.targetId}/backup/manifests/old.json`,
        manifestHash: "b".repeat(64),
        totalBytes: 0,
        objectCount: 0,
        generation: a.oldGeneration,
        format: SNAPSHOT_FORMAT_V2,
        appMeta: {},
      });
    } catch (error) {
      fenced =
        error instanceof BackupProviderError &&
        error.code === "conflict_generation";
    }
    expect(fenced).toBe(true);

    expect(report.reconcile).toMatchObject({
      checked: 2,
      missing: 0,
      repinned: [],
      lost: [],
    });
    expect(report.reconcile.skipped).toBeUndefined();

    expect(report.recoveredAsOf).toBeGreaterThan(0);
    expect({
      truncated: report.truncated,
      warmed: report.previews.warmed,
      hasReason: !report.previews.warmed && report.previews.reason.length > 0,
    }).toStrictEqual({
      truncated: false,
      warmed: false,
      hasReason: true,
    });
    if (report.previews.warmed)
      throw new Error("headless recovery must not pre-warm previews");
  }, 45_000);

  test("recovery refuses a snapshot written by newer software BEFORE any byte is fetched", async () => {
    const server = await startFakeProviderServer();
    cleanups.push(() => server.close());
    const a = await seedMachineA(server);

    const providerClient = openRemoteBackupProvider({
      baseUrl: a.serverUrl,
      apiKey: a.apiKey,
    });
    await providerClient.registerSnapshot(a.targetId, {
      idempotencyKey: "from-the-future",
      manifestKey: `u/${a.targetId}/backup/manifests/future.json`,
      manifestHash: "c".repeat(64),
      totalBytes: 0,
      objectCount: 0,
      generation: a.oldGeneration,
      format: SNAPSHOT_FORMAT_V2,
      appMeta: { vaultUserVersion: "9999", ontologyVersion: "1.0" },
    });

    const dataDir = await tempDir("recover-incompat");
    const layout = daemonLayoutFor(dataDir);
    await expect(
      recover({
        kitDocument: a.kitDocument,
        password: KIT_PASSWORD,
        apiKey: a.apiKey,
        vaultRoot: layout.vaultDir,
        dataDir: layout.dataDir,
        log: silentLogger,
      })
    ).rejects.toThrow(/vaultUserVersion 9999 is newer/u);

    expect(existsSync(path.join(layout.vaultDir, a.vaultId))).toBe(false);
    const rootEntries = existsSync(layout.vaultDir)
      ? await fs.readdir(layout.vaultDir)
      : [];
    expect(
      rootEntries.filter((e) => e.startsWith(".recover-staging-"))
    ).toHaveLength(0);
    expect(new KeyStore(layout.keysDir).export("keyring.key")).toBeNull();
  }, 45_000);

  test("adopt-time reconcile re-pins a replicated blob the provider dropped, and unmarks it", async () => {
    const server = await startFakeProviderServer();
    cleanups.push(() => server.close());
    const a = await seedMachineA(server);

    const casProvider = openRemoteBackupProvider({
      baseUrl: a.serverUrl,
      apiKey: a.apiKey,
    });
    const casStore = await casProvider.openDataPlane(
      a.targetId,
      "cas",
      "read-write"
    );
    await casStore.delete(`blobs/sha256/${a.originals[0]}`);

    const dataDir = await tempDir("recover-reconcile");
    const layout = daemonLayoutFor(dataDir);
    const report = await recover({
      kitDocument: a.kitDocument,
      password: KIT_PASSWORD,
      apiKey: a.apiKey,
      vaultRoot: layout.vaultDir,
      dataDir: layout.dataDir,
      log: silentLogger,
    });

    expect(report.reconcile.checked).toBe(2);
    expect(report.reconcile.missing).toBe(1);
    expect(report.reconcile.repinned).toStrictEqual([a.originals[0]]);
    expect(report.reconcile.lost).toStrictEqual([]);

    const vaultDir = path.join(layout.vaultDir, a.vaultId);
    const restoredBlobs = new FsBlobStore(path.join(vaultDir, "blobs"));
    expect(restoredBlobs.hasSync(a.originals[0]!)).toBe(true);
    expect(restoredBlobs.hasSync(a.originals[1]!)).toBe(false);
    expect(report.skippedBlobs).toBe(1); // only originals[1] deferred now

    const restoredDb = new DatabaseSync(path.join(vaultDir, "vault.db"), {
      readOnly: true,
    });
    try {
      const index = new ReplicaIndex(restoredDb);
      expect(index.has(a.originals[0]!)).toBe(false);
      expect(index.has(a.originals[1]!)).toBe(true);
    } finally {
      restoredDb.close();
    }
  }, 45_000);
});
