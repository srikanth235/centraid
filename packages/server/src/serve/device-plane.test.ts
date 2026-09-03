import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { EnrollmentStore, VaultOwnedError } from "./enrollment-store.js";
import { GatewayDatabase } from "./gateway-db.js";
import { OwnerRemovalError, OwnerStore } from "./owner-store.js";
import {
  PairingTicketStore,
  encodePairingTicket,
  parsePairingTicket,
} from "./pairing-store.js";

const cleanups: Array<() => Promise<void> | void> = [];
describe("device-plane scenarios", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function tempFile(name: string): Promise<string> {
    const dir = await tempDir(`device-plane-${crypto.randomUUID()}-`);
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    return path.join(dir, name);
  }

  test("enrollment: a device reaches its owner's vaults; revoke kills the binding", async () => {
    const file = await tempFile("gateway.db");
    const store = EnrollmentStore.open(file);

    const laptop = store.enroll({
      endpointId: "ep-laptop",
      vaultIds: ["v1"],
      label: "laptop",
      ownerLabel: "Priya",
    });
    store.enroll({
      endpointId: "ep-laptop",
      vaultIds: ["v2"],
      label: "laptop",
      ownerId: laptop.ownerId,
    });
    store.enroll({
      endpointId: "ep-phone",
      vaultIds: ["v3"],
      label: "phone",
      platform: "android",
      ownerLabel: "Sid",
    });

    expect(store.vaultsFor("ep-laptop")).toStrictEqual(["v1", "v2"]);
    expect(store.vaultsFor("ep-phone")).toStrictEqual(["v3"]);
    expect(store.isEnrolled("ep-nobody")).toBe(false);

    expect(() =>
      store.enroll({
        endpointId: "ep-phone",
        vaultIds: ["v1"],
        label: "phone",
      })
    ).toThrow(VaultOwnedError);

    store.enroll({
      endpointId: "ep-tablet",
      label: "tablet",
      ownerId: laptop.ownerId,
    });
    expect(store.vaultsFor("ep-tablet")).toStrictEqual(["v1", "v2"]);

    store.enroll({
      endpointId: "ep-laptop",
      vaultIds: ["v1"],
      label: "renamed laptop",
    });
    expect(store.vaultsFor("ep-laptop")).toStrictEqual(["v1", "v2"]);
    expect(
      store.list().find((e) => e.enrollmentId === laptop.enrollmentId)?.label
    ).toBe("renamed laptop");

    const removed = store.revoke("ep-laptop");
    expect(removed).toHaveLength(2);
    expect(store.isEnrolled("ep-laptop")).toBe(false);
    expect(store.vaultsFor("ep-tablet")).toStrictEqual(["v1", "v2"]);

    expect(() => store.removeOwner(laptop.ownerId)).toThrow(OwnerRemovalError);
    store.removeVault("v1");
    store.removeVault("v2");
    const orphaned = store.removeOwner(laptop.ownerId);
    expect(orphaned).toStrictEqual([]);
    expect(store.isEnrolled("ep-tablet")).toBe(false);
    expect(store.listByVault("v3").map((row) => row.endpointId)).toStrictEqual([
      "ep-phone",
    ]);
  });

  test("enrollment makes colliding client defaults distinguishable", async () => {
    const file = await tempFile("gateway.db");
    const store = EnrollmentStore.open(file);
    const first = store.enroll({
      endpointId: "browser-one",
      vaultIds: ["v1"],
      label: "Web browser · ABCD",
      ownerLabel: "Priya",
    });
    const second = store.enroll({
      endpointId: "browser-two",
      label: "Web browser · ABCD",
      ownerId: first.ownerId,
    });

    expect(first.label).toBe("Web browser · ABCD");
    expect(second.label).toBe("Web browser · ABCD · browser-two");
    expect(new Set(store.listByVault("v1").map((row) => row.label)).size).toBe(
      2
    );
  });

  test("enrollment: a second process's writes are visible without restart", async () => {
    const file = await tempFile("gateway.db");
    const daemon = EnrollmentStore.open(file, { statTtlMs: 0 });
    expect(daemon.isEnrolled("ep-new")).toBe(false);

    const cli = EnrollmentStore.open(file);
    cli.enroll({ endpointId: "ep-new", vaultIds: ["v1"], label: "new device" });

    expect(daemon.vaultsFor("ep-new")).toStrictEqual(["v1"]);
    expect((await fs.stat(file)).isFile()).toBe(true);
  });

  test("enrollment: replica checkpoints only advance within their bootstrap epoch", async () => {
    const file = await tempFile("gateway.db");
    const store = EnrollmentStore.open(file);
    store.enroll({
      endpointId: "ep-device",
      vaultIds: ["v1"],
      label: "laptop",
      rememberDevice: true,
    });

    const boot = store.resetCheckpoint("ep-device", "v1", {
      epoch: "epoch-a",
      seq: 7,
      schemaEpoch: 2,
    });
    expect(boot).toMatchObject({ epoch: "epoch-a", seq: 7, schemaEpoch: 2 });
    expect(
      store.advanceCheckpoint("ep-device", "v1", {
        epoch: "epoch-a",
        seq: 9,
        schemaEpoch: 2,
      })
    ).toMatchObject({ seq: 9 });
    expect(() =>
      store.advanceCheckpoint("ep-device", "v1", {
        epoch: "epoch-a",
        seq: 8,
        schemaEpoch: 2,
      })
    ).toThrow(/monotonically/u);
    expect(() =>
      store.advanceCheckpoint("ep-device", "v1", {
        epoch: "epoch-b",
        seq: 10,
        schemaEpoch: 2,
      })
    ).toThrow(/rebootstrap/u);

    const reopened = EnrollmentStore.open(file);
    expect(reopened.get("ep-device", "v1")?.checkpoint).toMatchObject({
      epoch: "epoch-a",
      seq: 9,
    });
  });

  test("enrollment: a stale daemon checkpoint cannot resurrect a CLI revocation", async () => {
    const file = await tempFile("gateway.db");
    const daemon = EnrollmentStore.open(file);
    const row = daemon.enroll({
      endpointId: "ep-lost",
      vaultIds: ["v1"],
      label: "lost laptop",
      rememberDevice: true,
    });
    daemon.resetCheckpoint("ep-lost", "v1", {
      epoch: "epoch-a",
      seq: 4,
      schemaEpoch: 2,
    });

    const cli = EnrollmentStore.open(file);
    expect(cli.revoke(row.enrollmentId)).toHaveLength(1);
    expect(() =>
      daemon.advanceCheckpoint("ep-lost", "v1", {
        epoch: "epoch-a",
        seq: 5,
        schemaEpoch: 2,
      })
    ).toThrow(/not enrolled/u);
    expect(EnrollmentStore.open(file).get("ep-lost", "v1")?.revoked).toBe(true);
    expect(EnrollmentStore.open(file).isEnrolled("ep-lost")).toBe(false);
    await expect(fs.stat(`${file}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("enrollment: gateway.db replaces the old lock directory", async () => {
    const file = await tempFile("gateway.db");
    const store = EnrollmentStore.open(file);
    store.enroll({ endpointId: "device", vaultIds: ["v1"], label: "Laptop" });
    await expect(fs.stat(`${file}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(path.basename(store.gatewayDatabase.file)).toBe("gateway.db");
  });

  test("enrollment: remember and Companion grants persist across re-pair", async () => {
    const file = await tempFile("gateway.db");
    const store = EnrollmentStore.open(file);
    store.enroll({
      endpointId: "ep-session",
      vaultIds: ["v1"],
      label: "borrowed tablet",
      rememberDevice: false,
      grantProfile: ["locker", "notes"],
    });
    expect(EnrollmentStore.open(file).get("ep-session", "v1")).toMatchObject({
      rememberDevice: false,
      grantProfile: ["locker", "notes"],
    });
    store.enroll({
      endpointId: "ep-session",
      vaultIds: ["v1"],
      label: "borrowed tablet",
      grantProfile: ["tasks"],
    });
    expect(
      EnrollmentStore.open(file).get("ep-session", "v1")?.grantProfile
    ).toStrictEqual(["tasks"]);
    expect(
      store.enroll({
        endpointId: "ep-default",
        vaultIds: ["v2"],
        label: "default device",
      })
    ).toMatchObject({ rememberDevice: false });

    store.enroll({
      endpointId: "ep-session",
      vaultIds: ["v1"],
      label: "full desktop",
      platform: "desktop",
    });
    expect(
      EnrollmentStore.open(file).get("ep-session", "v1")?.grantProfile
    ).toBeUndefined();
  });

  test("enrollment: obsolete JSON registries are not read or rewritten", async () => {
    const file = await tempFile("devices.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        enrollments: [
          {
            enrollmentId: "legacy-row",
            endpointId: "legacy-key",
            vaultId: "v1",
            label: "Older device",
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      })
    );

    expect(EnrollmentStore.open(file).get("legacy-key", "v1")).toBeUndefined();
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
      version: 1,
    });
  });

  test("pairing tickets: one-time, secret-checked, TTL-bound", async () => {
    const file = await tempFile("gateway.db");
    const store = PairingTicketStore.open(file);

    const owners = OwnerStore.open(store.gatewayDatabase);
    const priya = owners.create("Priya");
    const invite = (vaultIds: string[]) => ({
      ownerId: priya.ownerId,
      vaultIds,
    });
    const minted = store.mint(invite(["v1"]));
    expect(store.listActive()).toHaveLength(1);

    expect(store.redeem(minted.ticketId, "guessed")).toBeUndefined();
    expect(store.redeem(minted.ticketId, minted.secret)).toStrictEqual({
      ownerId: priya.ownerId,
      vaultIds: ["v1"],
    });

    const second = store.mint(invite(["v2", "v3"]));
    expect(store.redeem(second.ticketId, second.secret)).toStrictEqual({
      ownerId: priya.ownerId,
      vaultIds: ["v2", "v3"],
    });
    expect(store.redeem(second.ticketId, second.secret)).toBeUndefined();

    const brief = store.mint(invite(["v3"]), 1);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    expect(store.redeem(brief.ticketId, brief.secret)).toBeUndefined();
  });

  test("ticket redemption and enrollment commit atomically and one row wins concurrency", async () => {
    const file = await tempFile("gateway.db");
    const gateway = GatewayDatabase.open(path.dirname(file));
    cleanups.push(() => gateway.close());
    const tickets = PairingTicketStore.open(gateway);
    const enrollments = EnrollmentStore.open(gateway);
    const owners = OwnerStore.open(gateway);
    const priya = owners.create("Priya");
    const first = tickets.mint({
      ownerId: priya.ownerId,
      vaultIds: ["v1", "v2"],
    });

    expect(() =>
      tickets.redeemAndEnroll(
        first.ticketId,
        first.secret,
        enrollments,
        { endpointId: "phone", label: "Phone" },
        () => {
          throw new Error("injected crash");
        }
      )
    ).toThrow("injected crash");
    expect(tickets.listActive()).toHaveLength(1);
    expect(enrollments.get("phone", "v1")).toBeUndefined();
    expect(enrollments.get("phone", "v2")).toBeUndefined();
    expect(owners.vaultsOwnedBy(priya.ownerId)).toStrictEqual([]);

    const enrolled = tickets.redeemAndEnroll(
      first.ticketId,
      first.secret,
      enrollments,
      {
        endpointId: "phone",
        label: "Phone",
      }
    );
    expect(enrolled?.map((row) => row.vaultId)).toStrictEqual(["v1", "v2"]);
    expect(enrolled?.every((row) => row.ownerId === priya.ownerId)).toBe(true);
    expect(owners.vaultsOwnedBy(priya.ownerId)).toStrictEqual(["v1", "v2"]);

    const raced = tickets.mint({
      ownerId: priya.ownerId,
      vaultIds: ["v1"],
    });
    const results = await Promise.all([
      Promise.resolve().then(() =>
        tickets.redeemAndEnroll(raced.ticketId, raced.secret, enrollments, {
          endpointId: "tablet-a",
          label: "Tablet A",
        })
      ),
      Promise.resolve().then(() =>
        tickets.redeemAndEnroll(raced.ticketId, raced.secret, enrollments, {
          endpointId: "tablet-b",
          label: "Tablet B",
        })
      ),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("the pasteable ticket round-trips and rejects foreign payloads", () => {
    const token = encodePairingTicket({
      v: 1,
      kind: "centraid-gw-pair",
      gw: "endpoint-ticket-base32",
      t: "ticket-id",
      s: "secret",
      vaultName: "Family",
      exp: 123,
    });
    expect(parsePairingTicket(token)).toMatchObject({
      t: "ticket-id",
      vaultName: "Family",
    });
    expect(parsePairingTicket("not-a-ticket")).toBeUndefined();
    expect(
      parsePairingTicket(
        Buffer.from(JSON.stringify({ v: 1, kind: "centraid-pair" })).toString(
          "base64url"
        )
      )
    ).toBeUndefined();
  });
});
