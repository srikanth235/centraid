import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

import { describe, afterEach, expect, test, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { makeVaultRouteHandler } from "../routes/vault-routes.js";
import { EnrollmentStore } from "./enrollment-store.js";
import { GatewayDatabase } from "./gateway-db.js";
import {
  replicaIntentContext,
  runWithReplicaIntent,
} from "./replica-intent-context.js";
import { runWithVaultContext } from "./vault-context.js";
import { openVaultRegistry, VaultRegistryError } from "./vault-registry.js";
import type { VaultRegistry } from "./vault-registry.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];
describe("vault-registry scenarios", () => {
  afterEach(async () =>
    forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) => cleanup())
  );
  function openRegistry(rootDir: string): VaultRegistry {
    const registry = openVaultRegistry({
      rootDir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    if (registry.list().length === 0) registry.create();
    cleanups.push(() => registry.stop());
    return registry;
  }

  test("a fresh root holds no vault until an explicit create", async () => {
    const root = await tempDir();
    const registry = openVaultRegistry({
      rootDir: root,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => registry.stop());
    expect(registry.list()).toStrictEqual([]);
    expect(registry.isFresh()).toBe(true);
    expect(existsSync(path.join(root, "vaults.json"))).toBe(false);

    registry.create();
    const vaults = registry.list();
    expect(vaults).toHaveLength(1);
    expect(vaults[0]).toMatchObject({ name: "Priya's vault" });
    expect(existsSync(path.join(root, vaults[0]!.vaultId, "vault.db"))).toBe(
      true
    );
    expect(registry.defaultVaultId()).toBe(vaults[0]!.vaultId);
    expect(registry.isFresh()).toBe(false);
  });

  test("the default vault is the marked personal one, not the oldest, and survives a rename", async () => {
    const root = await tempDir();
    const registry = openVaultRegistry({
      rootDir: root,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => registry.stop());
    const shared = registry.create("Shared");
    const personal = registry.create("Personal", { personal: true });

    // The listing leads with the DEFAULT vault, not the oldest one (#665):
    // `Shared` is founded first, but `Personal` carries the marker.
    expect(registry.list().map((v) => v.vaultId)).toStrictEqual([
      personal.vaultId,
      shared.vaultId,
    ]);
    expect(registry.list().map((v) => v.personal)).toStrictEqual([
      true,
      undefined,
    ]);
    expect(registry.defaultVaultId()).toBe(personal.vaultId);

    // The desktop fresh path renames it to the owner's display name — the
    // marker lives in the vault, so the default does not move.
    registry.rename(personal.vaultId, "Priya");
    expect(registry.defaultVaultId()).toBe(personal.vaultId);

    // No marked vault at all (pre-marker data / erased personal vault) →
    // the previous oldest-first behaviour.
    registry.delete(personal.vaultId);
    expect(registry.defaultVaultId()).toBe(shared.vaultId);
    registry.delete(shared.vaultId);
    expect(registry.defaultVaultIdOrUndefined()).toBeUndefined();
    expect(() => registry.defaultVaultId()).toThrow(/no vault mounted/u);
  });

  test("listing hoists the marked vault to the head from any founding position (#665)", async () => {
    const root = await tempDir();
    const registry = openVaultRegistry({
      rootDir: root,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => registry.stop());
    const shared = registry.create("Shared");
    const personal = registry.create("Personal", { personal: true });
    const family = registry.create("Family");

    // Marked vault founded in the MIDDLE — it still heads the list, and the
    // remainder keeps its creation order (a hoist, never a shuffle).
    expect(registry.list().map((v) => v.vaultId)).toStrictEqual([
      personal.vaultId,
      shared.vaultId,
      family.vaultId,
    ]);
    expect(registry.list()[0]!.vaultId).toBe(registry.defaultVaultId());

    // Background iteration is deliberately NOT reordered: creation order.
    expect(registry.planesList().map((p) => p.boot.vaultId)).toStrictEqual([
      shared.vaultId,
      personal.vaultId,
      family.vaultId,
    ]);

    // No marked vault (pre-marker data dir, or an erased personal vault) →
    // byte-for-byte the old oldest-first order.
    registry.delete(personal.vaultId);
    expect(registry.list().map((v) => v.vaultId)).toStrictEqual([
      shared.vaultId,
      family.vaultId,
    ]);
    expect(registry.list()[0]!.vaultId).toBe(registry.defaultVaultId());
  });

  test("create / rename / delete permits the last vault to return to zero", async () => {
    const root = await tempDir();
    const registry = openRegistry(root);
    const first = registry.list()[0]!;

    const family = registry.create("Family");
    expect(family).toMatchObject({ name: "Family" });
    expect(registry.list()).toHaveLength(2);

    const renamed = registry.rename(family.vaultId, "Sharma family");
    expect(renamed.name).toBe("Sharma family");
    expect(() => registry.rename(family.vaultId, "   ")).toThrow(
      VaultRegistryError
    );

    registry.delete(first.vaultId);
    expect(registry.list()).toHaveLength(1);
    expect(existsSync(path.join(root, first.vaultId))).toBe(false);
    expect(registry.get(first.vaultId)).toBeUndefined();

    registry.delete(family.vaultId);
    expect(registry.list()).toStrictEqual([]);
    expect(registry.isFresh()).toBe(true);
  });

  test("runner cache lives OUTSIDE the vault tree (a `-cache` sibling) and is purged on delete", async () => {
    const root = await tempDir();
    const cacheRoot = path.join(
      path.dirname(root),
      `${path.basename(root)}-cache`
    );
    cleanups.push(() => fs.rm(cacheRoot, { recursive: true, force: true }));
    const registry = openRegistry(root);
    const first = registry.list()[0]!;

    const ws = registry.get(first.vaultId)!.workspace;
    // The runner scratch is NOT under the vault dir (journal.db is the source of
    // truth; this is disposable cache) — it's the per-vault `-cache` sibling.
    expect(
      ws.runnerSessionDir.startsWith(path.join(root, first.vaultId) + path.sep)
    ).toBe(false);
    expect(ws.runnerSessionDir).toBe(
      path.join(cacheRoot, first.vaultId, "runner-sessions")
    );

    // Deleting a vault also purges its cache dir (which the vault-dir rmSync
    // can't reach).
    const family = registry.create("Family");
    const famCache = path.join(cacheRoot, family.vaultId);
    await fs.mkdir(path.join(famCache, "runner-sessions"), { recursive: true });
    await fs.writeFile(
      path.join(famCache, "runner-sessions", "w1.jsonl"),
      "resume-state"
    );
    expect(existsSync(famCache)).toBe(true);
    registry.delete(family.vaultId);
    expect(existsSync(famCache)).toBe(false);
  });

  test("the registry survives a restart: same vaults, same names", async () => {
    const root = await tempDir();
    const first = openVaultRegistry({
      rootDir: root,
      logger: silentLogger,
      ownerName: "Priya",
    });
    first.create();
    first.create("Work");
    const ids = first
      .list()
      .map((v) => v.vaultId)
      .sort();
    first.stop();

    const second = openRegistry(root);
    expect(
      second
        .list()
        .map((v) => v.vaultId)
        .sort()
    ).toStrictEqual(ids);
    expect(second.list().map((v) => v.name)).toContain("Work");
    expect(second.current().boot.fresh).toBe(false);
  });

  test("current() resolves per request context; grants stay per vault (issue #289)", async () => {
    const root = await tempDir();
    const registry = openRegistry(root);
    const personal = registry.list()[0]!;
    const work = registry.create("Work");

    registry.enrollApp("planner");
    registry.current().approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "read" }],
    });

    const bridge = registry.bridgeFor("planner");
    const readReq = {
      op: "read" as const,
      payload: { entity: "schedule.task", purpose: "dpv:ServiceProvision" },
    };

    // Unscoped call rides the default vault, where the grant lives.
    const allowed = await bridge(readReq);
    expect(allowed.ok).toBe(true);

    // The SAME bridge, addressed to the other vault: the app's identity is
    // ensured on first call, but no grant exists — a receipted deny.
    const denied = await runWithVaultContext({ vaultId: work.vaultId }, () =>
      bridge(readReq)
    );
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("VAULT_CONSENT");

    // Two "clients" on two vaults, concurrently — neither disturbs the other.
    const [a, b] = await Promise.all([
      runWithVaultContext({ vaultId: personal.vaultId }, () => bridge(readReq)),
      runWithVaultContext({ vaultId: work.vaultId }, () => bridge(readReq)),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
  });

  test("an app-worker bridge carries request attribution into its later callback", async () => {
    const root = await tempDir();
    const registry = openRegistry(root);
    const personal = registry.list()[0]!;
    const work = registry.create("Work");
    const observed: Array<{
      vaultId: string;
      intent: ReturnType<typeof replicaIntentContext>;
    }> = [];
    for (const plane of registry.planesList()) {
      vi.spyOn(plane, "bridgeFor").mockReturnValue(async () => {
        observed.push({
          vaultId: registry.current().boot.vaultId,
          intent: replicaIntentContext(),
        });
        return { ok: true };
      });
    }
    const intent = {
      intentId: "offline-write-1",
      appId: "photos",
      deviceId: "sid-phone",
      ownerId: "owner-sid",
    };
    const bridge = runWithVaultContext({ vaultId: work.vaultId }, () =>
      runWithReplicaIntent(intent, () => registry.bridgeFor("photos"))
    );

    // The worker message arrives after both ambient scopes have unwound.
    await bridge({ op: "read", payload: {} });

    expect(observed).toStrictEqual([{ vaultId: work.vaultId, intent }]);
    expect(observed[0]?.vaultId).not.toBe(personal.vaultId);
  });

  test("a vault created out of band (admin CLI) mounts on first lookup", async () => {
    const root = await tempDir();
    const registry = openRegistry(root);

    // Second process (the admin CLI) creates a vault in the same root.
    const cli = openVaultRegistry({
      rootDir: root,
      logger: silentLogger,
      ownerName: "Priya",
    });
    const fresh = cli.create("Guest");
    cli.stop();

    // The running registry picks it up on the miss — no restart.
    expect(registry.get(fresh.vaultId)?.name).toBe("Guest");
    expect(registry.list().map((v) => v.vaultId)).toContain(fresh.vaultId);
  });

  test("late-mount listeners observe out-of-band mounts and can unsubscribe", async () => {
    const root = await tempDir();
    const registry = openRegistry(root);
    const mounted: string[] = [];
    const unsubscribe = registry.onMount((plane) =>
      mounted.push(plane.boot.vaultId)
    );

    const cli = openVaultRegistry({
      rootDir: root,
      logger: silentLogger,
      ownerName: "Priya",
    });
    const fresh = cli.create("Recovered");
    cli.stop();
    expect(registry.get(fresh.vaultId)).toBeDefined();
    expect(mounted).toStrictEqual([fresh.vaultId]);

    unsubscribe();
    registry.create("After unsubscribe");
    expect(mounted).toStrictEqual([fresh.vaultId]);
  });

  test("owner routes: list + create + rename/presentation; delete requires erase ceremony", async () => {
    const root = await tempDir();
    const registry = openRegistry(root);
    const database = GatewayDatabase.open(await tempDir());
    cleanups.push(() => database.close());
    const enrollments = EnrollmentStore.open(database);
    const firstVaultId = registry.defaultVaultId();
    enrollments.enroll({
      endpointId: "owner-device",
      vaultIds: [firstVaultId],
      label: "Owner device",
    });
    const handler = makeVaultRouteHandler(registry, { enrollments });
    const server = http.createServer((req, res) => {
      // Stand-in for the composed handler: scope each request to the vault
      // named by the addressing header, default vault otherwise.
      const requested = req.headers["x-centraid-vault"];
      const vaultId =
        typeof requested === "string" ? requested : registry.defaultVaultId();
      void runWithVaultContext({ vaultId, deviceKey: "owner-device" }, () =>
        handler(req, res)
      ).then((owned) => {
        if (!owned) {
          res.statusCode = 404;
          res.end("{}");
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${addr.port}/centraid/_vault`;

    // Status names the request's vault.
    const status = (await (await fetch(`${base}/status`)).json()) as Record<
      string,
      unknown
    >;
    expect(status).toMatchObject({ name: "Priya's vault" });

    // A proved owner creates another vault and receives a real enrollment.
    const created = await fetch(`${base}/vaults`, {
      method: "POST",
      body: JSON.stringify({ name: "Family" }),
    });
    expect(created.status).toBe(201);
    const family = (await created.json()) as { vaultId: string; name: string };
    // The creating owner claims the fresh vault (#726).
    expect(enrollments.get("owner-device", family.vaultId)?.revoked).toBe(
      false
    );
    expect(enrollments.owners.ownerOf(family.vaultId)).toBe(
      enrollments.ownerFor("owner-device")?.ownerId
    );
    const listed = (await (await fetch(`${base}/vaults`)).json()) as {
      vaults: unknown[];
    };
    expect(listed.vaults).toHaveLength(2);

    // Per-vault addressing: enroll an app only in the new vault, then read
    // both consent surfaces — they are disjoint.
    registry.get(family.vaultId)!.enrollApp("planner");
    const defaultApps = (await (await fetch(`${base}/apps`)).json()) as {
      apps: unknown[];
    };
    expect(defaultApps.apps).toHaveLength(0);
    const familyApps = (await (
      await fetch(`${base}/apps`, {
        headers: { "x-centraid-vault": family.vaultId },
      })
    ).json()) as { apps: Array<{ name: string }> };
    expect(familyApps.apps).toMatchObject([{ name: "planner" }]);

    // Rename + presentation ride PATCH; activation is not a server concept.
    const patched = (await (
      await fetch(`${base}/vaults/${family.vaultId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Sharma family", color: "#aa3355" }),
      })
    ).json()) as { name: string; color?: string };
    expect(patched).toMatchObject({ name: "Sharma family", color: "#aa3355" });

    // DELETE cannot bypass the typed-name recovery-kit erase ceremony.
    const veto = await fetch(`${base}/vaults/${family.vaultId}`, {
      method: "DELETE",
    });
    expect(veto.status).toBe(405);
    expect(registry.list()).toHaveLength(2);
  });

  // Issue #351: a corrupt vault used to vanish silently — `scannedDirs` marked
  // it as handled BEFORE the mount attempt, so a directory that failed to
  // open was never retried until process restart. These pin the fix: the
  // failure is recorded, retried (with backoff) on a later `scan()`, and
  // cleared once the directory becomes mountable.
  test("a directory that fails to mount is recorded in failedMounts, retried on a later scan (past backoff), and cleared once mountable", async () => {
    const clock = useFakeClock();
    try {
      const root = await tempDir();
      const donorRoot = await tempDir();

      // A directory with a `vault.db` that isn't a valid SQLite file at all —
      // the cheapest reliable way to make `openVaultDb` throw.
      const badDir = path.join(root, "badvault");
      await fs.mkdir(badDir, { recursive: true });
      await fs.writeFile(path.join(badDir, "vault.db"), "not a sqlite file");

      // A donor vault, bootstrapped through the real registry so its
      // vault.db/journal.db are genuinely valid and carry their own vaultId
      // (never mounted in the registry under test, so no id collision below).
      const donor = openVaultRegistry({
        rootDir: donorRoot,
        logger: silentLogger,
        ownerName: "Donor",
      });
      donor.create();
      const donorVaultId = donor.list()[0]!.vaultId;
      donor.stop();

      const registry = openVaultRegistry({
        rootDir: root,
        logger: silentLogger,
        ownerName: "Priya",
      });
      cleanups.push(() => registry.stop());

      // Construction's initial scan() tried badvault, failed, and — unlike
      // before the fix — did NOT permanently swallow it.
      let failed = registry.failedMounts();
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ dir: badDir });
      expect(failed[0]!.message.length).toBeGreaterThan(0);
      const firstAttemptAt = failed[0]!.at;
      // A corrupt directory never triggers an unrelated bootstrap.
      expect(registry.list()).toHaveLength(0);

      // Immediately rescanning stays within the backoff window — badvault is
      // still corrupt, but this also proves a naive fix (retry unconditionally
      // on every scan) isn't what's under test: the failure record is
      // untouched, not refreshed, because the attempt is skipped.
      registry.rescan();
      expect(registry.failedMounts()).toStrictEqual(failed);

      // The directory becomes mountable (an operator replaced the corrupt
      // file, or — as simulated here — a valid pair of DB files lands there).
      await fs.copyFile(
        path.join(donorRoot, donorVaultId, "vault.db"),
        path.join(badDir, "vault.db")
      );
      await fs.copyFile(
        path.join(donorRoot, donorVaultId, "journal.db"),
        path.join(badDir, "journal.db")
      );

      // Past the backoff window, the next scan retries it.
      vi.advanceTimersByTime(31_000);
      registry.rescan();

      failed = registry.failedMounts();
      expect(failed).toHaveLength(0);
      const mounted = registry.list().map((v) => v.vaultId);
      expect(mounted).toHaveLength(1);
      expect(mounted).toContain(donorVaultId);
      expect(firstAttemptAt).toBeDefined(); // sanity: we did capture a timestamp above
    } finally {
      clock.restore();
    }
  });

  // Issue #439 R1: the live-gateway adopt seam. `recover()` renames a restored
  // staging dir into `<root>/<vaultId>`; the running gateway then `adopt()`s it —
  // mounting it and dropping the pristine default the registry bootstrapped onto
  // the (previously empty) blank machine, so the recovered vault stands alone.
  test("adopt() mounts a recovered vault dir and removes the pristine auto-created default", async () => {
    // A "recovered" vault, produced by a real registry in a donor root (older id
    // than the blank machine's auto-default, exactly as a real recovery would be),
    // then stopped so its files are consistent to copy.
    const donorRoot = await tempDir();
    const donor = openVaultRegistry({
      rootDir: donorRoot,
      logger: silentLogger,
      ownerName: "Mara",
    });
    donor.create();
    const recoveredId = donor.list()[0]!.vaultId;
    donor.rename(recoveredId, "Recovered");
    donor.stop();

    // The blank machine remains empty until recovery adopts the restored vault.
    const root = await tempDir();
    const registry = openVaultRegistry({
      rootDir: root,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => registry.stop());
    expect(registry.list()).toHaveLength(0);

    // recover() renamed the restored dir into place; simulate that with a copy.
    await fs.cp(
      path.join(donorRoot, recoveredId),
      path.join(root, recoveredId),
      {
        recursive: true,
      }
    );
    const donorKey = path.join(donorRoot, "keys", `${recoveredId}.sealkey`);
    if (existsSync(donorKey)) {
      await fs.mkdir(path.join(root, "keys"), { recursive: true });
      await fs.cp(donorKey, path.join(root, "keys", `${recoveredId}.sealkey`));
    }

    const adopted = registry.adopt(recoveredId);

    expect(adopted.vaultId).toBe(recoveredId);
    expect(adopted.name).toBe("Recovered");
    // The recovered vault stands alone and is the effective default.
    expect(registry.list().map((v) => v.vaultId)).toStrictEqual([recoveredId]);
    expect(registry.defaultVaultId()).toBe(recoveredId);
  });

  test("a directory whose vault.db duplicates an already-mounted vault id is recorded in failedMounts too", async () => {
    const root = await tempDir();
    const registry = openRegistry(root);
    const first = registry.list()[0]!;
    const firstDir = path.join(root, first.vaultId);

    // Clone the mounted vault's files into a second directory — same
    // vaultId, so it can never cleanly mount alongside the original. The
    // `-wal` siblings are part of the clone: with `wal_autocheckpoint = 0`
    // (issue #408 — only the WAL shipper checkpoints), a live vault's recent
    // writes live in the WAL until the next shipper checkpoint, so a bare
    // `vault.db` copy would be an EMPTY database that bootstraps fresh under
    // a new id instead of colliding.
    const dupeDir = path.join(root, "dupe-of-first");
    await fs.mkdir(dupeDir, { recursive: true });
    await forEachSequentially(
      ["vault.db", "journal.db", "vault.db-wal", "journal.db-wal"],
      async (name) => {
        await fs
          .copyFile(path.join(firstDir, name), path.join(dupeDir, name))
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
      }
    );

    registry.rescan();

    const failed = registry.failedMounts();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ dir: dupeDir });
    expect(failed[0]!.message).toContain(first.vaultId);
    expect(registry.list()).toHaveLength(1);
  });
});
