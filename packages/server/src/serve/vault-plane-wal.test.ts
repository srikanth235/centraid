import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  KeyStore,
  aesGcmKeyProtector,
  ensureAppEnrolled,
} from "@centraid/vault";

import {
  directoryBytes,
  seedCalendar,
  silentLogger,
  usePlaneFixture,
} from "./vault-plane.test-fixtures.js";
import { openVaultRegistry } from "./vault-registry.js";

describe("vault-plane WAL ownership + durability", () => {
  const fixture = usePlaneFixture();

  test("fresh bootstrap checkpoints the WAL before the shipper attaches", async () => {
    const dir = await tempDir("fresh-bootstrap-wal-");
    fixture.openPlane(dir);
    const size = (await fs.stat(path.join(dir, "vault.db-wal"))).size;
    expect(size).toBeLessThanOrEqual(32 * 1024);
  });

  test("a protector-backed gateway reopens real sealed rows while a copied data dir cannot", async () => {
    const root = await tempDir("protected-vault-plane-");
    const vaultRoot = path.join(root, "vault");
    const masterKey = Buffer.alloc(32, 0x31);
    const keyStore = new KeyStore(path.join(root, "keys"), {
      protector: aesGcmKeyProtector(masterKey),
    });
    let registry = openVaultRegistry({
      rootDir: vaultRoot,
      keyStore,
      logger: silentLogger,
      ownerName: "Priya",
    });
    const created = registry.create("Protected");
    let plane = registry.get(created.vaultId)!;
    const added = plane.gateway.invoke(plane.ownerCredential, {
      command: "locker.add_item",
      input: {
        type: "login",
        title: "example.com",
        username: "priya",
        password: "protector-backed-secret",
        url: "https://example.com",
      },
      purpose: "dpv:ServiceProvision",
    });
    expect(added.status).toBe("executed");
    const itemId = (added as { output: { item_id: string } }).output.item_id;
    await expect(
      fs.readFile(keyStore.file(`${created.vaultId}.sealkey`), "utf8")
    ).resolves.toContain('"scheme":"aes-256-gcm-v1"');
    registry.stop();

    registry = openVaultRegistry({
      rootDir: vaultRoot,
      keyStore: new KeyStore(path.join(root, "keys"), {
        protector: aesGcmKeyProtector(masterKey),
      }),
      logger: silentLogger,
    });
    plane = registry.get(created.vaultId)!;
    expect(
      plane.gateway.reveal(plane.ownerCredential, {
        entity: "locker.item",
        entityId: itemId,
        columns: ["password"],
        purpose: "dpv:ServiceProvision",
      }).values
    ).toStrictEqual({ password: "protector-backed-secret" });
    registry.stop();

    const copied = await tempDir("copied-protected-vault-plane-");
    await fs.cp(root, copied, { recursive: true });
    const foreign = openVaultRegistry({
      rootDir: path.join(copied, "vault"),
      keyStore: new KeyStore(path.join(copied, "keys"), {
        protector: aesGcmKeyProtector(Buffer.alloc(32, 0x72)),
      }),
      logger: silentLogger,
    });
    expect(foreign.list()).toStrictEqual([]);
    expect(foreign.failedMounts()[0]?.message).toMatch(
      /authentication failed/u
    );
    foreign.stop();
  });

  test("a WAL-disabled vault plane never checkpoints another process's stream on stop", async () => {
    const dir = await tempDir();
    const plane = fixture.openPlaneWith({
      bootstrap: true,
      dir,
      ownerName: "Priya",
      enableWalShipper: false,
    });
    expect(plane.walShipper).toBeUndefined();

    let checkpoints = 0;
    plane.gateway.checkpoint = () => {
      checkpoints++;
      return { vault: "ok", journal: "ok" };
    };

    plane.stop();

    expect(checkpoints).toBe(0);
  });

  test("WAL ownership stays unconditional while capture follows backup configuration", async () => {
    const dir = await tempDir();
    let backupConfigured = false;
    const plane = fixture.openPlaneWith({
      bootstrap: true,
      dir,
      ownerName: "Priya",
      walCaptureConfigured: () => backupConfigured,
    });
    const shipper = plane.walShipper!;
    const tick = vi.spyOn(shipper, "tick");
    const close = vi.spyOn(shipper, "close");
    const autocheckpointPages = () =>
      [plane.db.vault, plane.db.audit].map((db) => {
        const row = db.prepare("PRAGMA wal_autocheckpoint").get() as Record<
          string,
          number
        >;
        return Object.values(row)[0];
      });

    plane.start();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(tick).not.toHaveBeenCalled();
    expect(plane.walShipper).toBe(shipper);
    expect(autocheckpointPages().every((pages) => (pages ?? 0) > 0)).toBe(true);

    backupConfigured = true;
    plane.rescheduleWalCapture();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(tick).toHaveBeenCalledOnce();
    expect(plane.walShipper).toBe(shipper);
    expect(autocheckpointPages()).toStrictEqual([0, 0]);

    backupConfigured = false;
    plane.rescheduleWalCapture();
    expect(plane.walShipper).toBe(shipper);
    expect(autocheckpointPages().every((pages) => (pages ?? 0) > 0)).toBe(true);
    const shipBytesBeforeStop = await directoryBytes(
      path.join(dir, "wal-ship")
    );
    plane.stop();
    expect(close).not.toHaveBeenCalled();
    await expect(directoryBytes(path.join(dir, "wal-ship"))).resolves.toBe(
      shipBytesBeforeStop
    );
  });

  test("ten real commands in one arrival window share one database batch", async () => {
    const dir = await tempDir();
    const plane = fixture.openPlane(dir);
    const calendarId = seedCalendar(plane);
    const batchSpy = vi.spyOn(plane.gateway, "invokeBatchSettled");

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        plane.invoke(plane.ownerCredential, {
          command: "schedule.propose_event",
          invocationId: `queue-real-${index}`,
          input: {
            summary: `Queued event ${index}`,
            dtstart: `2026-10-${String(index + 1).padStart(2, "0")}T09:00:00Z`,
            dtend: `2026-10-${String(index + 1).padStart(2, "0")}T09:15:00Z`,
            calendar_id: calendarId,
          },
        })
      )
    );

    expect(outcomes.every((outcome) => outcome.status === "executed")).toBe(
      true
    );
    expect(batchSpy).toHaveBeenCalledOnce();
    expect(batchSpy.mock.calls[0]?.[0]).toHaveLength(10);
    expect({
      ...plane.db.vault.prepare("SELECT count(*) AS n FROM core_event").get(),
    }).toStrictEqual({
      n: 10,
    });
    expect({
      ...plane.db.audit
        .prepare(
          `SELECT count(*) AS n FROM agent_command_invocation
          WHERE invocation_id LIKE 'queue-real-%' AND status = 'executed'`
        )
        .get(),
    }).toStrictEqual({ n: 10 });
  });

  test("one journal failure preserves its canonical marker while sibling writes commit", async () => {
    const dir = await tempDir();
    const plane = fixture.openPlane(dir);
    const calendarId = seedCalendar(plane);
    plane.db.audit.exec(`CREATE TEMP TRIGGER fail_one_queued_receipt
    BEFORE INSERT ON access_receipt
    WHEN NEW.invocation_id = 'queue-fail'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic queued journal failure');
    END`);

    const requests = ["queue-ok-a", "queue-fail", "queue-ok-b"].map(
      (invocationId, index) =>
        plane.invoke(plane.ownerCredential, {
          command: "schedule.propose_event",
          invocationId,
          input: {
            summary: invocationId,
            dtstart: `2026-11-0${index + 1}T09:00:00Z`,
            dtend: `2026-11-0${index + 1}T09:15:00Z`,
            calendar_id: calendarId,
          },
        })
    );
    const results = await Promise.allSettled(requests);

    expect(results.map((result) => result.status)).toStrictEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("queued journal failure"),
      }),
    });
    expect({
      ...plane.db.vault.prepare("SELECT count(*) AS n FROM core_event").get(),
    }).toStrictEqual({
      n: 3,
    });
    await plane.invoke(plane.ownerCredential, {
      command: "schedule.propose_event",
      invocationId: "cleanup-proven-queue-markers",
      input: {
        summary: "Cleanup pass",
        dtstart: "2026-11-04T09:00:00Z",
        dtend: "2026-11-04T09:15:00Z",
        calendar_id: calendarId,
      },
    });
    expect(
      plane.db.vault
        .prepare(
          `SELECT invocation_id, journal_finalized_at FROM replica_invocation_commit
          WHERE invocation_id LIKE 'queue-%' ORDER BY invocation_id`
        )
        .all()
        .map((row) => ({ ...row }))
    ).toStrictEqual([
      { invocation_id: "queue-fail", journal_finalized_at: null },
    ]);
    expect(
      plane.db.audit
        .prepare(
          `SELECT invocation_id FROM agent_command_invocation
          WHERE invocation_id LIKE 'queue-ok-%' AND status = 'executed'
          ORDER BY invocation_id`
        )
        .all()
        .map((row) => ({ ...row }))
    ).toStrictEqual([
      { invocation_id: "queue-ok-a" },
      { invocation_id: "queue-ok-b" },
    ]);
  });

  test("the plane survives a restart: same identity, grants intact, ctx.vault still works", async () => {
    const dir = await tempDir();
    const first = fixture.openPlaneWith({
      bootstrap: true,
      dir,
      ownerName: "Priya",
    });
    expect(first.boot.fresh).toBe(true);
    ensureAppEnrolled(first.db, "planner", { riskCeiling: "medium" });
    first.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });
    const calendarId = seedCalendar(first);
    const vaultId = first.boot.vaultId;
    first.stop();
    first.stop(); // idempotent

    const second = fixture.openPlane(dir);
    expect(second.boot.fresh).toBe(false);
    expect(second.boot.vaultId).toBe(vaultId);
    const apps = second.listApps();
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ name: "planner" });
    expect(apps[0]?.grants).toHaveLength(1);

    const outcome = await second.bridgeFor("planner")({
      op: "invoke",
      payload: {
        command: "schedule.propose_event",
        input: {
          summary: "Retro",
          dtstart: "2026-07-05T09:00:00Z",
          dtend: "2026-07-05T09:30:00Z",
          calendar_id: calendarId,
        },
        purpose: "dpv:ServiceProvision",
      },
    });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { status: string }).status).toBe("executed");
  });
});
