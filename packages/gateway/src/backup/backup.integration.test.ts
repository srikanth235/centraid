import crypto, { randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
// governance: allow-repo-hygiene file-size-limit (#363) the full-story end-to-end test built exactly the way build-gateway.ts constructs BackupService (no injected provider/assembleEntries); splitting the story would break the point of an end-to-end test
/*
 * The full-story end-to-end test for the offsite backup feature
 * (PROTOCOL.md/FORMAT.md): NO injected provider, NO injected
 * `assembleEntries` — `BackupService` is constructed exactly the way
 * `build-gateway.ts` does (config + backupDir + vaults + health + logger
 * only), against a REAL seeded vault, a REAL `LocalBackupProvider` on a
 * temp dir, restored through the REAL CLI (`commandBackup`), and adopted
 * as a live vault the way an operator recovering onto a new machine would.
 *
 * One shared seeded vault carries most of the suite (beforeAll) to keep
 * runtime sane; tests that mutate provider state in ways that would affect
 * siblings (corruption, generation fencing) are deliberately ordered last.
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
  /** Real command invocation, throwing loudly on refusal — mirrors every other real-vault test in this suite. */
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

  /** Stage bytes through the real blob pipeline, then claim them onto a subject via core.attach. */
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

  /** Stage + approve one outbox item (mirrors vault-quarantine.test.ts's helper) — quarantine needs something real to park. */
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

  /** One real commit in the plane's own code store via a real WorktreeStore publish. */
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

    // 1. Seed a REAL vault: several data rows, real blobs (one > 1MiB, so it
    // spans multiple FastCDC chunks), a real published app (code-store
    // commit), a real sealed value, and one approved outbox item so the
    // eventual quarantine has something real to park.
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

    // #630 P5 preservation canary: the profile lifecycle columns and the
    // exact pre-trash revision must both survive snapshot/adoption.
    const peoplePartyId = invoke(h.plane, "people.add_person", {
      display_name: "Maya Chen",
      role: "Design lead",
      cadence_days: 14,
    })["party_id"] as string;
    const peopleRevisionId = invoke(h.plane, "people.trash_person", {
      party_id: peoplePartyId,
    })["revision_id"] as string;

    // #630 P1/P5 preservation canary: a canonical receipt is more than its
    // blob. The expense, receipt link, reviewed OCR derivative, structured
    // lines, allocations, and attachment must cross the same recovery plane.
    const ownerPartyId = (
      h.plane.db.vault
        .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
        .get() as { owner_party_id: string }
    ).owner_party_id;
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

    // 2. First real backup — REAL assembleSourceEntries → REAL LocalBackupProvider.
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

  // No-change and incremental registration live in ONE place each:
  //   - the engine laws (nothing registered when nothing moved; a change ships
  //     only the changed chunks) are owned by packages/backup/src/engine.test.ts
  //     ("no-change run registers nothing …" / "incremental second snapshot …").
  //   - the vault-shaped input those laws depend on — the pinned db base clones
  //     and the ref-digest-gated code bundle that make an idle vault genuinely
  //     byte-identical — is owned by backup-sources.test.ts ("db bases are the
  //     shipper pinned clones read IN PLACE …" / "the code-store bundle is
  //     REUSED untouched while refs are unchanged, and REGENERATED when they
  //     move"). This file keeps only fencing, policy echo, and CLI restore.

  test("CLI restore materializes a fresh dest, and adopting it as a live vault mounts, returns real data, and fires quarantine", async () => {
    const sourceReplica = currentReplicaLogState(h.plane.db.vault);
    // Stop the shared registry before the CLI opens its own on the same
    // vaultDir (mirrors backup-admin.test.ts's pattern — avoid two live
    // connections to the same vault.db at once).
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
    expect(result.entries).toContain("journal.db");
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

    // Adopt the restored directory as a live vault — mirroring recovery onto
    // a fresh machine: a fresh registry root, the vault files placed under
    // <root>/<vaultId>/, the seal key placed at <root>/keys/<vaultId>.sealkey
    // per sealKeyFileFor's layout rule, and the code store rebuilt from the
    // restored git bundle.
    const freshRoot = await tempDir("e2e-adopted-root");
    const adoptedDir = path.join(freshRoot, h.vaultId);
    await fs.mkdir(adoptedDir, { recursive: true });
    await fs.copyFile(
      path.join(destDir, "vault.db"),
      path.join(adoptedDir, "vault.db")
    );
    await fs.copyFile(
      path.join(destDir, "journal.db"),
      path.join(adoptedDir, "journal.db")
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
    const restoredIdentity = sourceKeys.export(`${h.vaultId}.identity`);
    if (!restoredIdentity) throw new Error("source identity missing");
    const adoptedKeyStore = daemonKeyStore(path.join(freshRoot, "keys"));
    adoptedKeyStore.import(`${h.vaultId}.sealkey`, restoredSealKey);
    adoptedKeyStore.import(`${h.vaultId}.identity`, restoredIdentity);
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
      // The plane MOUNTS — catches "restored DB is garbage" and "seal key
      // custody mismatch" both at once (openVaultDb's resolveSealKey refuses
      // to open on a fingerprint mismatch).
      const adopted = adoptedRegistry.get(h.vaultId);
      expect(adopted).toBeTruthy();
      const plane = adopted!;
      // Adoption/migration must not invalidate it again: restore performed the
      // one epoch bump after WAL materialization.
      expect(currentReplicaLogState(plane.db.vault).epoch).toBe(
        restoredReplica.epoch
      );

      // Quarantine fired on this mount, and the pre-staged approved outbox
      // item got parked for real.
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

      // Original data rows come back via a real owner-credentialed query.
      const rows = plane.sqlAsOwner(
        "SELECT title FROM schedule_task ORDER BY title"
      ).rows as Array<{
        title: string;
      }>;
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

      // Byte-identical blob content via the real blob read path.
      const smallRead = await plane.db.blobs.open(h.seeded.smallBlobSha);
      expect(smallRead).not.toBeNull();
      expect(smallRead!.equals(h.seeded.smallBlobBytes)).toBe(true);
      const bigRead = await plane.db.blobs.open(h.seeded.bigBlobSha);
      expect(bigRead).not.toBeNull();
      expect(bigRead!.equals(h.seeded.bigBlobBytes)).toBe(true);

      // The sealed value decrypts — the seal-key round trip.
      const lockerRow = plane.db.vault
        .prepare("SELECT password FROM locker_item WHERE item_id = ?")
        .get(h.seeded.lockerItemId) as { password: string };
      const decrypted = unsealValue(
        plane.db.sealKey,
        sealAad("locker_item", "password", h.seeded.lockerItemId),
        lockerRow.password
      );
      expect(decrypted).toBe(h.seeded.lockerPlaintext);

      // The #630 user-presence boundary is durable, while its capabilities
      // are not: the verifier restores with the vault DEK, but the source
      // gateway's live session was memory-only and must not survive.
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

    // The git bundle restores independently, too — clone + verify.
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

    // Reopen the shared registry for the remaining tests (fencing, verify).
    reopen();
  }, 30_000);

  test("fencing for real: a second BackupService registers gen+1; the first service fences on its next run", async () => {
    const targetId = (await h.service.status())[h.vaultId]!.targetId;
    const provider: BackupProvider = openLocalBackupProvider({
      rootDir: h.providerDir,
    });
    const beforeGen = (await provider.getTarget(targetId)).currentGeneration;

    // Simulate a second gateway's restore-takeover (PROTOCOL.md § Generation
    // fencing): a fresh state dir, seeded with a COPY of the real state +
    // keyring (a takeover reads the SAME keyring off the recovery kit), with
    // its target generation bumped to currentGeneration + 1 — exactly what
    // "read currentGeneration from the target and register the next snapshot
    // with currentGeneration + 1" means in state-file terms.
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
    expect(afterGen).toBe(beforeGen + 1); // the "other machine" won the target

    // The original service's NEXT run (still at the old generation) must
    // fence: health error, no bump, no exception escaping the caller — this
    // is the real product code path that Gap 1's stale-cache bug would have
    // silently defeated (serviceB's own LocalBackupProvider instance is
    // SEPARATE from serviceA's — exactly the cross-process shape the bug
    // affected).
    const before = (await h.service.status())[h.vaultId];
    // serviceB's own run moved the shipper's pinned bases, so serviceA's next
    // run has real work and therefore reaches the provider — which now 409s.
    await h.service.runBackup(h.vaultId);
    const after = (await h.service.status())[h.vaultId];
    expect(after?.fenced).toBe(true);
    expect(after?.generation).toBe(before?.generation); // never bumped automatically
    expect(after?.lastError).toMatch(/another machine has taken over/u);

    const snap = await h.health.snapshot();
    expect(snap.components.find((c) => c.component === "backups")?.status).toBe(
      "error"
    );
  });

  // Verify (a deleted chunk is reported missing, a flipped chunk corrupt) and
  // restore refusal (a newer vaultUserVersion / a non-empty dest are refused
  // before anything is fetched or materialized) are ENGINE laws, owned by
  // packages/backup/src/engine.test.ts — `describe(verifySnapshot)` and the two
  // roundtrip refusal tests. The gateway adds no logic on those paths: the
  // non-empty check exists only in engine.ts, and the deleted "verify catches
  // real damage" test called `verifySnapshot` directly. What the gateway DOES
  // add — that a refused recovery leaves no residue on a blank machine — lives
  // in recover.integration.test.ts's blank-machine test. This file keeps only
  // fencing, policy echo, and the CLI-restore -> adopt -> quarantine flow.
});
