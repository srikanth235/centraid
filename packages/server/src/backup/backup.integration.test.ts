import crypto, { randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
// governance: allow-repo-hygiene file-size-limit (#363) the full-story end-to-end test built exactly the way build-gateway.ts constructs BackupService (no injected provider/assembleEntries); splitting the story would break the point of an end-to-end test
/*
 * Full-story backup E2E (PROTOCOL.md/FORMAT.md): no injected provider or
 * `assembleEntries` — constructed as `build-gateway.ts` does, real vault,
 * real LocalBackupProvider, real CLI restore, adopted as a live vault.
 * Shared seeded vault in beforeAll; mutating tests last.
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { openLocalBackupProvider } from "@centraid/backup";
import type { BackupProvider } from "@centraid/backup";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  currentReplicaLogState,
  sealAad,
  unsealValue,
  updateBackupPolicy,
} from "@centraid/vault";

import { commandBackup } from "../cli/backup-admin.js";
import { daemonKeyStore } from "../cli/key-store.js";
import { daemonLayoutFor } from "../cli/paths.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { HealthRegistry } from "../serve/health-registry.js";
import { runWithVaultContext } from "../serve/vault-context.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { openVaultRegistry } from "../serve/vault-registry.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { run } from "../worktree-store/git.js";
import { WorktreeStore } from "../worktree-store/worktree-store.js";
import type { BackupConfig } from "./backup-config.js";
import { BackupService } from "./backup-service.js";
import { loadBackupState, saveBackupState } from "./backup-state.js";

vi.setConfig({ testTimeout: 30_000 });

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];
describe("backup", () => {
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

  function stageAndAttach(
    plane: VaultPlane,
    subjectId: string,
    bytes: Buffer
  ): string {
    const staged = plane.gateway.stageBlob(plane.ownerCredential, {
      bytes,
      mediaType: "application/octet-stream",
      filename: "payload.bin",
    });
    invoke(plane, "core.attach", {
      subject_type: "schedule.task",
      subject_id: subjectId,
      staged_sha: staged.sha256,
    });
    return staged.sha256;
  }

  function seedApprovedOutboxItem(plane: VaultPlane): {
    itemId: string;
    grantId: string;
  } {
    invoke(plane, "sync.configure_credential", {
      kind: "pull.gmail",
      label: "personal",
      cred_kind: "api_key",
      api_key: "sk-e2e-test",
      allowed_hosts: ["gmail.googleapis.com"],
    });
    const staged = invoke(plane, "outbox.stage", {
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
    });
    const itemId = staged["item_id"] as string;
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

  async function capture(fn: () => Promise<void> | void): Promise<string> {
    const original = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    process.stdout.write = ((chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await fn();
    } finally {
      process.stdout.write = original;
    }
    return chunks.join("");
  }

  function jsonLines(out: string): unknown[] {
    return out
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as unknown);
  }

  interface Seeded {
    taskTitles: string[];
    smallBlobSha: string;
    smallBlobBytes: Buffer;
    bigBlobSha: string;
    bigBlobBytes: Buffer;
    lockerItemId: string;
    lockerPlaintext: string;
    lockerPassphrase: string;
    outboxItemId: string;
    peoplePartyId: string;
    peopleRevisionId: string;
    receiptExpenseId: string;
    receiptId: string;
  }

  interface Harness {
    dataDir: string;
    configPath: string;
    providerDir: string;
    backupDir: string;
    config: BackupConfig;
    vaultDir: string;
    vaultId: string;
    registry: VaultRegistry;
    plane: VaultPlane;
    service: BackupService;
    gatewayDatabase: GatewayDatabase;
    health: HealthRegistry;
    seeded: Seeded;
  }

  let h: Harness;

  function reopen(): void {
    h.gatewayDatabase = GatewayDatabase.open(h.dataDir);
    const keyStore = daemonKeyStore(path.join(h.dataDir, "keys"));
    keyStore.loadOrCreate("endpoint-key.bin");
    h.registry = openVaultRegistry({
      rootDir: h.vaultDir,
      cacheRootDir: h.backupDir,
      keyStore,
      logger: silentLogger,
      ownerName: "Priya",
    });
    if (h.registry.isFresh()) h.registry.create("Personal");
    const vaultId = h.vaultId || h.registry.defaultVaultId();
    h.plane = h.registry.get(vaultId)!;
    h.vaultId = vaultId;
    h.health = new HealthRegistry();
    h.service = new BackupService({
      config: h.config,
      cacheDir: h.backupDir,
      gatewayDatabase: h.gatewayDatabase,
      keyStore,
      vaults: h.registry,
      health: h.health,
      logger: silentLogger,
    });
  }

  beforeAll(async () => {
    const dataDir = await tempDir("e2e-data");
    const providerDir = await tempDir("e2e-provider");
    const credentialRoot = await tempDir("e2e-host-credentials");
    const previousCredentialRoot =
      process.env["CENTRAID_KEYSTORE_CREDENTIAL_ROOT"];
    process.env["CENTRAID_KEYSTORE_CREDENTIAL_ROOT"] = credentialRoot;
    cleanups.push(() => {
      if (previousCredentialRoot === undefined) {
        delete process.env["CENTRAID_KEYSTORE_CREDENTIAL_ROOT"];
      } else {
        process.env["CENTRAID_KEYSTORE_CREDENTIAL_ROOT"] =
          previousCredentialRoot;
      }
    });
    const layout = daemonLayoutFor(dataDir);
    const config: BackupConfig = {
      enabled: true,
      provider: { kind: "local", dir: providerDir },
    };
    const configPath = path.join(dataDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ dataDir, backup: config }));

    h = {
      dataDir,
      configPath,
      providerDir,
      backupDir: layout.cacheDir,
      config,
      vaultDir: layout.vaultDir,
      vaultId: "",
      registry: undefined as unknown as VaultRegistry,
      plane: undefined as unknown as VaultPlane,
      service: undefined as unknown as BackupService,
      gatewayDatabase: undefined as unknown as GatewayDatabase,
      health: undefined as unknown as HealthRegistry,
      seeded: undefined as unknown as Seeded,
    };
    reopen();
    updateBackupPolicy(h.plane.db.vault, {
      snapshotIntervalHours: 1,
      verifyEveryDays: 1,
    });
    cleanups.push(async () => {
      await h.service.stop();
      h.registry.stop();
      h.gatewayDatabase.close();
    });

    // Seed: rows, a >1MiB blob (multi-chunk), published app, sealed value, approved outbox.
    const taskTitles = ["Frame the print", "Pay the invoice", "Call the vet"];
    const taskIds = taskTitles.map(
      (title) =>
        invoke(h.plane, "schedule.add_task", { title })["task_id"] as string
    );

    const PNG =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const smallOut = invoke(h.plane, "core.attach", {
      subject_type: "schedule.task",
      subject_id: taskIds[0],
      data_uri: PNG,
    });
    const smallContentId = smallOut["content_id"] as string;
    const smallBlobSha = (
      h.plane.db.vault
        .prepare(
          "SELECT content_uri FROM core_content_item WHERE content_id = ?"
        )
        .get(smallContentId) as { content_uri: string }
    ).content_uri.slice("blob:sha256-".length);
    const smallBlobBytes = Buffer.from(
      PNG.slice(PNG.indexOf(",") + 1),
      "base64"
    );

    const bigBlobBytes = randomBytes(1_600_000); // > 1MiB — multiple FastCDC chunks
    const bigBlobSha = stageAndAttach(h.plane, taskIds[1]!, bigBlobBytes);

    await publishRealApp(h.plane, "todo");

    const lockerPlaintext = "H2$kL9mVq!pR4wZ";
    const lockerOut = invoke(h.plane, "locker.add_item", {
      type: "login",
      title: "GitHub",
      username: "priya",
      password: lockerPlaintext,
    });
    const lockerItemId = lockerOut["item_id"] as string;
    const lockerPassphrase = "a second horse guards this vault";
    const lockerAuth = await h.plane.gateway.authenticateLocker({
      operation: "configure",
      secret: lockerPassphrase,
    });
    if (!lockerAuth.ok)
      throw new Error(
        `Locker auth setup failed: ${JSON.stringify(lockerAuth)}`
      );

    const { itemId: outboxItemId } = seedApprovedOutboxItem(h.plane);

    // #630 P5: lifecycle columns and pre-trash revision survive snapshot/adoption.
    const peoplePartyId = invoke(h.plane, "people.add_person", {
      display_name: "Maya Chen",
      role: "Design lead",
      cadence_days: 14,
    })["party_id"] as string;
    const peopleRevisionId = invoke(h.plane, "people.trash_person", {
      party_id: peoplePartyId,
    })["revision_id"] as string;

    // #630 P1/P5: receipt graph (expense, OCR, lines, allocations, attach) must survive.
    const ownerPartyId = (
      h.plane.db.vault
        .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
        .get() as { self_party_id: string }
    ).self_party_id;
    const receiptGroupId = invoke(h.plane, "tally.create_group", {
      name: "Backup receipt",
      icon: "🧾",
      member_ids: [],
    })["group_id"] as string;
    const stagedReceipt = h.plane.gateway.stageBlob(h.plane.ownerCredential, {
      bytes: Buffer.from("receipt-backup-canary"),
      filename: "receipt.jpg",
      mediaType: "image/jpeg",
    });
    const receiptOutput = invoke(h.plane, "tally.add_receipt_expense", {
      group_id: receiptGroupId,
      description: "Backup dinner",
      amount_minor: 1_200,
      paid_by: ownerPartyId,
      category: "food",
      splits: [{ party_id: ownerPartyId, share_minor: 1_200 }],
      staged_sha: stagedReceipt.sha256,
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

    h.seeded = {
      taskTitles,
      smallBlobSha,
      smallBlobBytes,
      bigBlobSha,
      bigBlobBytes,
      lockerItemId,
      lockerPlaintext,
      lockerPassphrase,
      outboxItemId,
      peoplePartyId,
      peopleRevisionId,
      receiptExpenseId: receiptOutput["expense_id"] as string,
      receiptId: receiptOutput["receipt_id"] as string,
    };

    await h.service.runBackup(h.vaultId);
    const first = (await h.service.status())[h.vaultId];
    if (first?.lastSeq !== 1)
      throw new Error("initial backup did not register sequence 1");
  }, 30_000);

  afterAll(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  // No-change / incremental laws live in engine.test.ts; vault-shaped input
  // in backup-sources.test.ts. This file: fencing, policy echo, CLI restore.

  test("CLI restore materializes a fresh dest, and adopting it as a live vault mounts, returns real data, and fires quarantine", async () => {
    const sourceReplica = currentReplicaLogState(h.plane.db.vault);
    // Close the shared registry before the CLI opens the same vault.db.
    await h.service.stop();
    h.registry.stop();
    h.gatewayDatabase.close();

    const destDir = path.join(h.dataDir, "restored");
    const out = await capture(() =>
      commandBackup(
        [
          "restore",
          "--config",
          h.configPath,
          "--vault",
          h.vaultId,
          "--dest",
          destDir,
        ],
        (msg) => {
          throw new Error(msg);
        }
      )
    );
    const [result] = jsonLines(out) as [{ seq: number; entries: string[] }];
    expect(result.entries).toContain("vault.db");
    expect(result.entries).toContain("apps.bundle");
    expect(result.entries).not.toContain("seal.key");
    expect(existsSync(path.join(destDir, "RESTORE_QUARANTINE.json"))).toBe(
      true
    );
    const restoredDb = new DatabaseSync(path.join(destDir, "vault.db"));
    const restoredReplica = currentReplicaLogState(restoredDb);
    restoredDb.close();
    expect(restoredReplica.epoch).not.toBe(sourceReplica.epoch);
    expect(restoredReplica.epochReason).toBe("backup-restore");

    // Adopt as a live vault: layout is sealKeyFileFor's; rebuild code store from the bundle.
    const freshRoot = await tempDir("e2e-adopted-root");
    const adoptedDir = path.join(freshRoot, h.vaultId);
    await fs.mkdir(adoptedDir, { recursive: true });
    await fs.copyFile(
      path.join(destDir, "vault.db"),
      path.join(adoptedDir, "vault.db")
    );
    await fs.cp(path.join(destDir, "blobs"), path.join(adoptedDir, "blobs"), {
      recursive: true,
    });
    await fs.copyFile(
      path.join(destDir, "RESTORE_QUARANTINE.json"),
      path.join(adoptedDir, "RESTORE_QUARANTINE.json")
    );
    const sourceKeys = daemonKeyStore(path.join(h.dataDir, "keys"));
    const restoredSealKey = sourceKeys.export(`${h.vaultId}.sealkey`);
    if (!restoredSealKey) throw new Error("source seal key missing");
    const adoptedKeyStore = daemonKeyStore(path.join(freshRoot, "keys"));
    adoptedKeyStore.import(`${h.vaultId}.sealkey`, restoredSealKey);
    await fs.mkdir(path.join(adoptedDir, "code"), { recursive: true });
    await run(
      [
        "clone",
        "--quiet",
        "--bare",
        path.join(destDir, "apps.bundle"),
        path.join(adoptedDir, "code", "apps.git"),
      ],
      {
        cwd: freshRoot,
      }
    );

    const adoptedRegistry = openVaultRegistry({
      rootDir: freshRoot,
      keyStore: adoptedKeyStore,
      logger: silentLogger,
      ownerName: "Priya",
    });
    try {
      // Mount catches garbage DB and seal-key fingerprint mismatch together.
      const adopted = adoptedRegistry.get(h.vaultId);
      expect(adopted).toBeTruthy();
      const plane = adopted!;
      // Restore already epoch-bumped after WAL; adoption must not bump again.
      expect(currentReplicaLogState(plane.db.vault).epoch).toBe(
        restoredReplica.epoch
      );

      // Quarantine parked the pre-staged approved outbox item.
      expect(plane.quarantine).not.toBeNull();
      expect(plane.quarantine?.outboxParked).toBeGreaterThanOrEqual(1);
      const outboxRow = plane.db.vault
        .prepare("SELECT status, grant_id FROM outbox_item WHERE item_id = ?")
        .get(h.seeded.outboxItemId) as {
        status: string;
        grant_id: string | null;
      };
      expect(outboxRow.status).toBe("pending");
      expect(outboxRow.grant_id).toBeNull();

      const rows = runWithVaultContext(
        {
          vaultId: plane.boot.vaultId,
          ownerId: plane.boot.ownerPartyId,
          ownsVault: true,
        },
        () =>
          plane.sqlAsAssistant("SELECT title FROM schedule_task ORDER BY title")
            .rows
      ) as Array<{ title: string }>;
      const titles = rows.map((r) => r.title);
      for (const t of h.seeded.taskTitles) expect(titles).toContain(t);

      const restoredPerson = plane.db.vault
        .prepare(
          `SELECT pr.role, pr.deleted_at, pr.purge_at, r.operation,
                  r.entity_type, r.entity_id, r.snapshot_json
             FROM people_profile pr
             JOIN core_entity_revision r
               ON r.revision_id = ?
            WHERE pr.party_id = ?`
        )
        .get(h.seeded.peopleRevisionId, h.seeded.peoplePartyId) as {
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
        entity_id: h.seeded.peoplePartyId,
      });
      expect(restoredPerson.deleted_at).not.toBeNull();
      expect(restoredPerson.purge_at).not.toBeNull();
      expect(JSON.parse(restoredPerson.snapshot_json)).toMatchObject({
        role: "Design lead",
        deleted_at: null,
        purge_at: null,
      });

      const restoredReceipt = plane.db.vault
        .prepare(
          `SELECT r.target_id AS expense_id, d.text_content,
                  count(DISTINCT l.line_item_id) AS line_count,
                  count(a.party_id) AS allocation_count
             FROM core_attachment r
             JOIN core_content_derivative d
               ON d.content_id = r.content_id AND d.variant = 'text'
             JOIN tally_expense_line_item l ON l.receipt_id = r.attachment_id
             JOIN tally_expense_line_allocation a
               ON a.line_item_id = l.line_item_id
            WHERE r.attachment_id = ? AND r.target_type = 'tally.expense'
              AND r.role = 'receipt'
            GROUP BY r.target_id, d.text_content`
        )
        .get(h.seeded.receiptId) as {
        expense_id: string;
        text_content: string;
        line_count: number;
        allocation_count: number;
      };
      expect(restoredReceipt).toMatchObject({
        expense_id: h.seeded.receiptExpenseId,
        text_content: "Dinner 10.00\nTax 2.00",
        line_count: 2,
        allocation_count: 2,
      });
      expect(
        plane.db.vault
          .prepare(
            `SELECT role, is_primary FROM core_attachment
              WHERE target_type = 'tally.expense' AND target_id = ?`
          )
          .get(h.seeded.receiptExpenseId)
      ).toMatchObject({ role: "receipt", is_primary: 1 });

      const smallRead = await plane.db.blobs.open(h.seeded.smallBlobSha);
      expect(smallRead).not.toBeNull();
      expect(smallRead!.equals(h.seeded.smallBlobBytes)).toBe(true);
      const bigRead = await plane.db.blobs.open(h.seeded.bigBlobSha);
      expect(bigRead).not.toBeNull();
      expect(bigRead!.equals(h.seeded.bigBlobBytes)).toBe(true);

      const lockerRow = plane.db.vault
        .prepare("SELECT password FROM locker_item WHERE item_id = ?")
        .get(h.seeded.lockerItemId) as { password: string };
      const decrypted = unsealValue(
        plane.db.sealKey,
        sealAad("locker_item", "password", h.seeded.lockerItemId),
        lockerRow.password
      );
      expect(decrypted).toBe(h.seeded.lockerPlaintext);

      // #630: presence is durable; live session capabilities were memory-only.
      await expect(
        plane.gateway.authenticateLocker({ operation: "status" })
      ).resolves.toMatchObject({
        ok: true,
        configured: true,
        authenticated: false,
      });
      await expect(
        plane.gateway.authenticateLocker({
          operation: "unlock",
          secret: h.seeded.lockerPassphrase,
        })
      ).resolves.toMatchObject({
        ok: true,
        configured: true,
        authenticated: true,
      });
    } finally {
      adoptedRegistry.stop();
    }

    const bareRepo = path.join(adoptedDir, "code", "apps.git");
    await expect(
      run(["bundle", "verify", path.join(destDir, "apps.bundle")], {
        cwd: bareRepo,
      })
    ).resolves.toBeTruthy();
    const clone2 = await tempDir("e2e-bundle-clone");
    await run(["clone", "--quiet", bareRepo, clone2], { cwd: freshRoot });
    const appJson = JSON.parse(
      await fs.readFile(path.join(clone2, "apps", "todo", "app.json"), "utf8")
    ) as { id: string };
    expect(appJson.id).toBe("todo");

    // Reopen the shared registry for fencing.
    reopen();
  }, 30_000);

  test("fencing for real: a second BackupService registers gen+1; the first service fences on its next run", async () => {
    const targetId = (await h.service.status())[h.vaultId]!.targetId;
    const provider: BackupProvider = openLocalBackupProvider({
      rootDir: h.providerDir,
    });
    const beforeGen = (await provider.getTarget(targetId)).currentGeneration;

    // Restore-takeover: copy state+keyring, bump generation +1 (PROTOCOL.md fencing).
    const backupDir2 = await tempDir("e2e-backupdir-takeover");
    const gatewayDatabase2 = GatewayDatabase.open(backupDir2);
    const keyStore2 = daemonKeyStore(path.join(backupDir2, "keys"));
    keyStore2.import("endpoint-key.bin", Buffer.from("b".repeat(64), "hex"));
    const liveKeyring = daemonKeyStore(path.join(h.dataDir, "keys")).export(
      "keyring.key"
    );
    if (!liveKeyring) throw new Error("fixture keyring missing");
    keyStore2.import("keyring.key", liveKeyring);
    const state = await loadBackupState(h.gatewayDatabase);
    state.targets[h.vaultId]!.generation = beforeGen + 1;
    await saveBackupState(gatewayDatabase2, state);

    const health2 = new HealthRegistry();
    const serviceB = new BackupService({
      config: h.config,
      cacheDir: backupDir2,
      gatewayDatabase: gatewayDatabase2,
      keyStore: keyStore2,
      vaults: h.registry,
      health: health2,
      logger: silentLogger,
    });
    await serviceB.runBackup(h.vaultId);
    await serviceB.stop();
    gatewayDatabase2.close();
    const afterGen = (await provider.getTarget(targetId)).currentGeneration;
    expect(afterGen).toBe(beforeGen + 1);

    // Service A (old generation) must fence: health error, no bump, no throw.
    // Separate provider instances (cross-process). B moved the pinned bases,
    // so A has real work and hits the 409.
    const before = (await h.service.status())[h.vaultId];
    await h.service.runBackup(h.vaultId);
    const after = (await h.service.status())[h.vaultId];
    expect(after?.fenced).toBe(true);
    expect(after?.generation).toBe(before?.generation);
    expect(after?.lastError).toMatch(/another machine has taken over/u);

    const snap = await h.health.snapshot();
    expect(snap.components.find((c) => c.component === "backups")?.status).toBe(
      "error"
    );
  });

  // Verify/refusal laws: engine.test.ts. Blank-machine residue:
  // recover.integration.test.ts. This file: fencing, policy echo, CLI restore.
});
