import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { currentReplicaLogState } from "@centraid/vault";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { makeMultiplexReplicaRouteHandler } from "./multiplex-replica-routes.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

class MockResponse extends EventTarget {
  statusCode = 200;
  body = "";
  writableEnded = false;
  onWrite?: (chunk: string) => void;
  readonly #listeners = new Map<string, Set<() => void>>();

  on(type: string, listener: () => void): this {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
    this.addEventListener(type, listener);
    return this;
  }

  off(type: string, listener: () => void): this {
    this.#listeners.get(type)?.delete(listener);
    this.removeEventListener(type, listener);
    return this;
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }

  setHeader(): this {
    return this;
  }

  flushHeaders(): void {}

  write(value: string | Buffer): boolean {
    const chunk = String(value);
    this.body += chunk;
    this.onWrite?.(chunk);
    return true;
  }

  end(value?: string | Buffer): this {
    if (value !== undefined) this.body += String(value);
    this.writableEnded = true;
    return this;
  }
}

function request(url: string, deviceId: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    url,
    method: "GET",
    headers: { [AUTHED_DEVICE_HEADER]: deviceId },
  }) as unknown as IncomingMessage;
}

async function fixture(): Promise<{
  personal: VaultPlane;
  family: VaultPlane;
  enrollments: EnrollmentStore;
  handler: ReturnType<typeof makeMultiplexReplicaRouteHandler>;
  deviceId: string;
}> {
  const root = await tempDir(`multiplex-${crypto.randomUUID()}-`);
  const personal = openVaultPlane({
    bootstrap: true,
    dir: path.join(root, "personal"),
    logger,
    enableWalShipper: false,
  });
  const family = openVaultPlane({
    bootstrap: true,
    dir: path.join(root, "family"),
    logger,
    enableWalShipper: false,
  });
  const enrollments = EnrollmentStore.open(path.join(root, "gateway.db"));
  const deviceId = "offline-phone";
  enrollments.enroll({
    endpointId: deviceId,
    label: "Offline phone",
    ownerLabel: "Priya",
    vaultIds: [personal.boot.vaultId, family.boot.vaultId],
  });
  const planes = new Map([
    [personal.boot.vaultId, personal],
    [family.boot.vaultId, family],
  ]);
  const vaults = {
    get: (vaultId: string) => planes.get(vaultId),
  } as unknown as VaultRegistry;
  cleanups.push(
    () => fs.rm(root, { recursive: true, force: true }),
    () => personal.stop(),
    () => family.stop()
  );
  return {
    personal,
    family,
    enrollments,
    handler: makeMultiplexReplicaRouteHandler(vaults, enrollments, {
      heartbeatMs: 5,
    }),
    deviceId,
  };
}

function streamPath(planes: readonly VaultPlane[]): string {
  const mounts = planes.map((plane) => ({
    vaultId: plane.boot.vaultId,
    cursor: currentReplicaLogState(plane.db.vault).watermark,
  }));
  return `/centraid/_gateway/replica/changes?${new URLSearchParams({
    mounts: JSON.stringify(mounts),
  })}`;
}

describe("multiplex replica route", () => {
  afterEach(async () => {
    await Promise.all(
      cleanups
        .splice(0)
        .toReversed()
        .map((cleanup) => cleanup())
    );
  });

  test("reconnect emits one scoped tombstone without blocking a valid mount", async () => {
    const f = await fixture();
    const familyState = currentReplicaLogState(f.family.db.vault);
    f.enrollments.resetCheckpoint(f.deviceId, f.family.boot.vaultId, {
      ...familyState.watermark,
      schemaEpoch: familyState.schemaEpoch,
    });
    // Ownership of the family vault ends while the phone is offline — the
    // ownership analogue of the old grant removal.
    f.enrollments.owners.removeVault(f.family.boot.vaultId);
    const req = request(streamPath([f.personal, f.family]), f.deviceId);
    const res = new MockResponse();
    res.onWrite = (chunk) => {
      if (chunk.includes('"event":"revoked"')) req.emit("close");
    };

    await f.handler(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      `"vaultId":"${f.family.boot.vaultId}","event":"revoked"`
    );
    expect(res.body).not.toContain(
      `"vaultId":"${f.personal.boot.vaultId}","event":"revoked"`
    );
    expect(res.body.match(/"event":"revoked"/gu)).toHaveLength(1);
  });

  test("an unknown vault still fails before opening a privacy-bearing stream", async () => {
    const f = await fixture();
    const mounts = [
      {
        vaultId: "vault-never-known",
        cursor: currentReplicaLogState(f.personal.db.vault).watermark,
      },
    ];
    const req = request(
      `/centraid/_gateway/replica/changes?${new URLSearchParams({
        mounts: JSON.stringify(mounts),
      })}`,
      f.deviceId
    );
    const res = new MockResponse();

    await f.handler(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("replica_scope_not_enrolled");
    expect(res.body).not.toContain("event: scope");
  });

  test("response failures still end the stream and release listeners", async () => {
    const f = await fixture();
    const familyState = currentReplicaLogState(f.family.db.vault);
    f.enrollments.resetCheckpoint(f.deviceId, f.family.boot.vaultId, {
      ...familyState.watermark,
      schemaEpoch: familyState.schemaEpoch,
    });
    // Ownership of the family vault ends while the phone is offline — the
    // ownership analogue of the old grant removal.
    f.enrollments.owners.removeVault(f.family.boot.vaultId);
    const req = request(streamPath([f.personal, f.family]), f.deviceId);
    const res = new MockResponse();
    res.write = () => {
      throw new Error("socket write failed");
    };

    await expect(
      f.handler(req, res as unknown as ServerResponse)
    ).rejects.toThrow("socket write failed");
    expect(res.writableEnded).toBe(true);
    expect(req.listenerCount("close")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });
});
