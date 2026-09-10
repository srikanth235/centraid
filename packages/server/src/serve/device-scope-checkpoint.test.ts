/*
 * THE GATEWAY'S RECORD OF WHICH DEVICE MOUNTS WHICH VAULT (#1014, V2/V18/X9).
 *
 * `device_checkpoints` is the durable proof a device has mounted a scope, and
 * until this issue it had no production writer at all: `hadReplicaScope` was
 * permanently false, `DeviceEnrollment.checkpoint` permanently `undefined`, the
 * Household device list's `checkpoint` permanently absent, and `revoke()`'s
 * checkpoint drop a no-op over an empty table. Two properties are pinned here —
 * the write itself, and what an ownership change does to it, which is the
 * security half: the row survived a vault changing hands, so the ex-owner's
 * phone went on passing the multiplex gate.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { EnrollmentStore } from "./enrollment-store.js";

const cleanups: Array<() => Promise<void>> = [];

async function store(): Promise<EnrollmentStore> {
  const root = await tempDir(`device-scope-${crypto.randomUUID()}-`);
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return EnrollmentStore.open(path.join(root, "gateway.db"));
}

const CURSOR = { epoch: "epoch-a", seq: 4, schemaEpoch: 1 };

describe("a device's scope checkpoint", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  test("a served page records the scope, and a later page advances it", async () => {
    const enrollments = await store();
    enrollments.enroll({
      endpointId: "phone",
      label: "Phone",
      ownerLabel: "Priya",
      vaultIds: ["vault-a"],
    });
    expect(enrollments.hadReplicaScope("phone", "vault-a")).toBe(false);

    expect(enrollments.noteCheckpoint("phone", "vault-a", CURSOR)).toBe(true);
    expect(enrollments.hadReplicaScope("phone", "vault-a")).toBe(true);
    expect(enrollments.get("phone", "vault-a")?.checkpoint?.seq).toBe(4);

    expect(
      enrollments.noteCheckpoint("phone", "vault-a", { ...CURSOR, seq: 9 })
    ).toBe(true);
    expect(enrollments.get("phone", "vault-a")?.checkpoint?.seq).toBe(9);
  });

  test("it never goes backwards, and a new epoch resets rather than refusing", async () => {
    const enrollments = await store();
    enrollments.enroll({
      endpointId: "phone",
      label: "Phone",
      ownerLabel: "Priya",
      vaultIds: ["vault-a"],
    });
    enrollments.noteCheckpoint("phone", "vault-a", { ...CURSOR, seq: 9 });

    expect(
      enrollments.noteCheckpoint("phone", "vault-a", { ...CURSOR, seq: 2 }),
      "a page behind the recorded position tells the gateway nothing new"
    ).toBe(false);
    expect(enrollments.get("phone", "vault-a")?.checkpoint?.seq).toBe(9);

    // The vault's log was rebuilt: the device is being served the new epoch's
    // pages, so refusing would leave the record stuck on an epoch nobody is on.
    expect(
      enrollments.noteCheckpoint("phone", "vault-a", {
        epoch: "epoch-b",
        seq: 1,
        schemaEpoch: 1,
      })
    ).toBe(true);
    expect(enrollments.get("phone", "vault-a")?.checkpoint).toMatchObject({
      epoch: "epoch-b",
      seq: 1,
    });
  });

  test("a vault changing hands drops the ex-owner's devices' scope", async () => {
    // THE REGRESSION THIS PINS (#1014, V18). `setOwner` was `INSERT OR REPLACE`
    // and deleted nothing else, so the previous owner's phone kept the durable
    // proof that it mounts this vault — and `hadReplicaScope` reads exactly
    // that table, so it went on passing the multiplex gate and subscribing to
    // the new owner's commit hub before the per-mount check stopped it.
    const enrollments = await store();
    enrollments.enroll({
      endpointId: "ex-phone",
      label: "Ex phone",
      ownerLabel: "Priya",
      vaultIds: ["vault-a"],
    });
    enrollments.noteCheckpoint("ex-phone", "vault-a", CURSOR);
    expect(enrollments.hadReplicaScope("ex-phone", "vault-a")).toBe(true);

    const next = enrollments.owners.create("Sam");
    enrollments.owners.setOwner("vault-a", next.ownerId);

    expect(enrollments.hadReplicaScope("ex-phone", "vault-a")).toBe(false);
  });
});
