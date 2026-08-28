import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  appendReplicaChange,
  currentReplicaLogState,
  pruneReplicaChanges,
} from "@centraid/vault";
import type { ReplicaCursor } from "@centraid/vault";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { makeMultiplexReplicaRouteHandler } from "./multiplex-replica-routes.js";
import type { MultiplexReplicaRouteOptions } from "./multiplex-replica-routes.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];
type FixtureOptions = MultiplexReplicaRouteOptions & {
  includeFamily?: boolean;
};

class MockResponse extends EventTarget {
  statusCode = 200;
  body = "";
  writableEnded = false;
  destroyed = false;
  /** What Node has queued for a client that is not reading (SseStream's bound). */
  writableLength = 0;
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

  destroy(): this {
    this.destroyed = true;
    this.dispatchEvent(new Event("close"));
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

async function fixture(options: FixtureOptions = {}): Promise<{
  personal: VaultPlane;
  family?: VaultPlane;
  enrollments: EnrollmentStore;
  handler: ReturnType<typeof makeMultiplexReplicaRouteHandler>;
  deviceId: string;
}> {
  const { includeFamily = true, ...routeOptions } = options;
  const root = await tempDir(`multiplex-${crypto.randomUUID()}-`);
  const personal = openVaultPlane({
    bootstrap: true,
    dir: path.join(root, "personal"),
    logger,
    enableWalShipper: false,
  });
  const family = includeFamily
    ? openVaultPlane({
        bootstrap: true,
        dir: path.join(root, "family"),
        logger,
        enableWalShipper: false,
      })
    : undefined;
  const enrollments = EnrollmentStore.open(path.join(root, "gateway.db"));
  const deviceId = "offline-phone";
  enrollments.enroll({
    endpointId: deviceId,
    label: "Offline phone",
    ownerLabel: "Priya",
    vaultIds: [personal.boot.vaultId, ...(family ? [family.boot.vaultId] : [])],
  });
  const planes = new Map([[personal.boot.vaultId, personal]]);
  if (family) planes.set(family.boot.vaultId, family);
  const vaults = {
    get: (vaultId: string) => planes.get(vaultId),
  } as unknown as VaultRegistry;
  cleanups.push(
    () => fs.rm(root, { recursive: true, force: true }),
    () => personal.stop()
  );
  if (family) cleanups.push(() => family.stop());
  return {
    personal,
    family,
    enrollments,
    handler: makeMultiplexReplicaRouteHandler(vaults, enrollments, {
      heartbeatMs: 5,
      ...routeOptions,
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

interface ScopeFrame {
  vaultId: string;
  event: string;
  data: unknown;
}

function scopeFrames(body: string): ScopeFrame[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: scope\n"))
    .map(
      (frame) =>
        JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as ScopeFrame
    );
}

function cursorsFor(body: string, vaultId: string): ReplicaCursor[] {
  return scopeFrames(body)
    .filter((frame) => frame.event === "cursor" && frame.vaultId === vaultId)
    .map((frame) => frame.data as ReplicaCursor);
}

/** Log entries a mounted phone has yet to see; the rows themselves stay absent. */
function backlog(plane: VaultPlane, count: number, prefix: string): number[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      appendReplicaChange(plane.db.vault, {
        entity: "schedule.task",
        rowId: `${prefix}-${index}`,
        op: "insert",
      }).seq
  );
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
    const familyState = currentReplicaLogState(f.family!.db.vault);
    f.enrollments.resetCheckpoint(f.deviceId, f.family!.boot.vaultId, {
      ...familyState.watermark,
      schemaEpoch: familyState.schemaEpoch,
    });
    // Ownership of the family vault ends while the phone is offline — the
    // ownership analogue of a grant removal.
    f.enrollments.owners.removeVault(f.family!.boot.vaultId);
    const req = request(streamPath([f.personal, f.family!]), f.deviceId);
    const res = new MockResponse();
    res.onWrite = (chunk) => {
      if (chunk.includes('"event":"revoked"')) req.emit("close");
    };

    await f.handler(req, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      `"vaultId":"${f.family!.boot.vaultId}","event":"revoked"`
    );
    expect(res.body).not.toContain(
      `"vaultId":"${f.personal.boot.vaultId}","event":"revoked"`
    );
    expect(res.body.match(/"event":"revoked"/gu)).toHaveLength(1);
  });

  test("a multi-page backlog drains without waiting for the heartbeat", async () => {
    // A heartbeat far longer than the test: every page after the first can only
    // arrive because the route re-projected immediately on `hasMore`.
    const f = await fixture({
      heartbeatMs: 600_000,
      limit: 1,
      includeFamily: false,
    });
    const mounted = streamPath([f.personal]);
    const seqs = backlog(f.personal, 3, "drain");
    const req = request(mounted, f.deviceId);
    const res = new MockResponse();
    res.onWrite = (chunk) => {
      if (chunk.includes(`"seq":${seqs.at(-1)}`)) req.emit("close");
    };

    await f.handler(req, res as unknown as ServerResponse);

    expect(
      cursorsFor(res.body, f.personal.boot.vaultId).map((cursor) => cursor.seq)
    ).toStrictEqual(seqs);
    expect(res.body).not.toContain(": heartbeat");
  });

  test("draining pages keeps each mount on its own cursor", async () => {
    const f = await fixture({ heartbeatMs: 600_000, limit: 1 });
    const mounted = streamPath([f.personal, f.family!]);
    const personalSeqs = backlog(f.personal, 3, "personal");
    const familySeqs = backlog(f.family!, 2, "family");
    const req = request(mounted, f.deviceId);
    const res = new MockResponse();
    res.onWrite = () => {
      const done =
        cursorsFor(res.body, f.personal.boot.vaultId).length ===
          personalSeqs.length &&
        cursorsFor(res.body, f.family!.boot.vaultId).length ===
          familySeqs.length;
      if (done) req.emit("close");
    };

    await f.handler(req, res as unknown as ServerResponse);

    const personalEpoch = currentReplicaLogState(f.personal.db.vault).watermark
      .epoch;
    const familyEpoch = currentReplicaLogState(f.family!.db.vault).watermark
      .epoch;
    expect(personalEpoch).not.toBe(familyEpoch);
    // Each mount advances through its own log, one page at a time, and no frame
    // ever carries the other vault's epoch.
    expect(cursorsFor(res.body, f.personal.boot.vaultId)).toStrictEqual(
      personalSeqs.map((seq) => ({ epoch: personalEpoch, seq }))
    );
    expect(cursorsFor(res.body, f.family!.boot.vaultId)).toStrictEqual(
      familySeqs.map((seq) => ({ epoch: familyEpoch, seq }))
    );
    for (const frame of scopeFrames(res.body)) {
      expect(Object.keys(frame)).toStrictEqual(["vaultId", "event", "data"]);
    }
  });

  test("a pruned mount rebootstraps alone while the other keeps streaming", async () => {
    const f = await fixture({ heartbeatMs: 600_000, limit: 1 });
    const personalCursor = currentReplicaLogState(
      f.personal.db.vault
    ).watermark;
    // The family cursor this phone last persisted, then that vault moves on and
    // retention prunes past it while the phone is offline.
    const stale = currentReplicaLogState(f.family!.db.vault).watermark;
    backlog(f.family!, 2, "pruned");
    pruneReplicaChanges(f.family!.db.vault, {
      maxAgeMs: 0,
      now: new Date(Date.now() + 60_000),
    });
    expect(
      currentReplicaLogState(f.family!.db.vault).floor.seq
    ).toBeGreaterThan(stale.seq);
    const personalSeqs = backlog(f.personal, 3, "healthy");
    const req = request(
      `/centraid/_gateway/replica/changes?${new URLSearchParams({
        mounts: JSON.stringify([
          { vaultId: f.personal.boot.vaultId, cursor: personalCursor },
          { vaultId: f.family!.boot.vaultId, cursor: stale },
        ]),
      })}`,
      f.deviceId
    );
    const res = new MockResponse();
    res.onWrite = () => {
      if (
        cursorsFor(res.body, f.personal.boot.vaultId).length ===
        personalSeqs.length
      )
        req.emit("close");
    };

    await f.handler(req, res as unknown as ServerResponse);

    // One scoped rebootstrap for the pruned vault, named by its own reason —
    // and only one, because that mount stops projecting for the connection.
    expect(
      scopeFrames(res.body).filter((frame) => frame.event === "rebootstrap")
    ).toStrictEqual([
      {
        vaultId: f.family!.boot.vaultId,
        event: "rebootstrap",
        data: expect.objectContaining({ reason: "retention" }),
      },
    ]);
    // The healthy mount drained every page regardless.
    expect(
      cursorsFor(res.body, f.personal.boot.vaultId).map((cursor) => cursor.seq)
    ).toStrictEqual(personalSeqs);
    expect(cursorsFor(res.body, f.family!.boot.vaultId)).toStrictEqual([]);
  });

  test("a phone that stops reading is dropped instead of buffered", async () => {
    const f = await fixture({
      heartbeatMs: 600_000,
      limit: 1,
      includeFamily: false,
    });
    const mounted = streamPath([f.personal]);
    backlog(f.personal, 3, "stalled");
    const req = request(mounted, f.deviceId);
    const res = new MockResponse();
    // The socket already holds more than the bounded writer's ceiling: the
    // phone has stopped draining. Raw `res.write` would queue on top of it.
    res.writableLength = 4 * 1024 * 1024;

    await f.handler(req, res as unknown as ServerResponse);

    expect(res.destroyed).toBe(true);
    expect(res.body).toBe("");
    expect(req.listenerCount("close")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });

  test("an unknown vault still fails before opening a privacy-bearing stream", async () => {
    const f = await fixture({ includeFamily: false });
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
    const familyState = currentReplicaLogState(f.family!.db.vault);
    f.enrollments.resetCheckpoint(f.deviceId, f.family!.boot.vaultId, {
      ...familyState.watermark,
      schemaEpoch: familyState.schemaEpoch,
    });
    // Ownership of the family vault ends while the phone is offline — the
    // ownership analogue of a grant removal.
    f.enrollments.owners.removeVault(f.family!.boot.vaultId);
    const req = request(streamPath([f.personal, f.family!]), f.deviceId);
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
