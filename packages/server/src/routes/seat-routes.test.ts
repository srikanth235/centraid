// THE SEAT DOORS, EXERCISED (#996, R4/R5).
//
// Two doors and a declared third, over a real vault plane: the sanitised file
// with its ranges and its ETag, the log tail with its bounds and its epoch
// gate, and the locker-key door that hands `K` to an enrolled device row —
// and to nothing else, which is the half of R13 the pairing ticket is not
// allowed to carry.

import crypto from "node:crypto";
import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  beginReplicaCommit,
  endReplicaCommit,
  openVaultDb,
  REPLICA_SCHEMA_EPOCH,
} from "@centraid/vault";
import { buildOntologyScenarios } from "@centraid/vault/tests/ontology-scenarios";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import {
  encodePairingTicket,
  parsePairingTicket,
} from "../serve/pairing-ticket-codec.js";
import { runWithVaultContext } from "../serve/vault-context.js";
import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import {
  makeSeatRouteHandler,
  parseByteRange,
  SEAT_LOCKER_KEY_PATH,
  SEAT_LOG_PATH,
  SEAT_SNAPSHOT_PATH,
} from "./seat-routes.js";
import { MockResponse } from "./seat-routes.test-fixtures.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

describe("seat-routes", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function fixture(): Promise<{
    plane: VaultPlane;
    handler: ReturnType<typeof makeSeatRouteHandler>;
    unscoped: ReturnType<typeof makeSeatRouteHandler>;
    enrollments: EnrollmentStore;
    deviceKey: string;
  }> {
    const dir = await tempDir(`seat-routes-${crypto.randomUUID()}-`);
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger,
      enableWalShipper: false,
    });
    const enrollments = EnrollmentStore.open(path.join(dir, "gateway.db"));
    const vaults = { current: () => plane } as unknown as VaultRegistry;
    const unscoped = makeSeatRouteHandler(vaults, { enrollments });
    const deviceKey = "seat-device";
    enrollments.enroll({
      endpointId: deviceKey,
      vaultIds: [plane.boot.vaultId],
      label: "Seat",
      rememberDevice: true,
    });
    const handler: typeof unscoped = (req, res) =>
      runWithVaultContext({ vaultId: plane.boot.vaultId, deviceKey }, () =>
        unscoped(req, res)
      );
    cleanups.push(
      () => fs.rm(dir, { recursive: true, force: true }),
      () => plane.stop()
    );
    return { plane, handler, unscoped, enrollments, deviceKey };
  }

  function request(
    url: string,
    headers: Record<string, string> = {}
  ): IncomingMessage {
    return Object.assign(Readable.from([]), {
      url,
      method: "GET",
      headers,
    }) as unknown as IncomingMessage;
  }

  /** One captured commit, the way every canonical write path makes one. */
  function commit(plane: VaultPlane, write: () => void): void {
    plane.db.vault.exec("BEGIN");
    const handle = beginReplicaCommit(plane.db.vault, { producer: "test" });
    try {
      write();
      endReplicaCommit(plane.db.vault, handle);
      plane.db.vault.exec("COMMIT");
    } catch (error) {
      plane.db.vault.exec("ROLLBACK");
      throw error;
    }
  }

  function note(plane: VaultPlane, id: string, title: string): void {
    commit(plane, () =>
      plane.db.vault
        .prepare(
          `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
           VALUES (?, ?, ?, '1')`
        )
        .run(id, `urn:${id}`, title)
    );
  }

  test("every door fails closed without an authenticated device", async () => {
    const { unscoped } = await fixture();
    const routes = [
      SEAT_SNAPSHOT_PATH,
      SEAT_LOG_PATH,
      SEAT_LOCKER_KEY_PATH,
    ] as const;
    const answers = await Promise.all(
      routes.map(async (route) => {
        const res = new MockResponse();
        await unscoped(request(route), res as unknown as ServerResponse);
        return { route, res };
      })
    );
    for (const { route, res } of answers) {
      expect(res.statusCode, route).toBe(403);
      expect(res.json(), route).toMatchObject({
        error: "replica_device_identity_required",
      });
    }
  });

  test("the locker-key door serves K to the enrolled device row", async () => {
    const { plane, handler } = await fixture();
    const res = new MockResponse();
    await handler(
      request(SEAT_LOCKER_KEY_PATH),
      res as unknown as ServerResponse
    );
    expect(res.statusCode).toBe(200);
    const live = plane.db.lockerKey();
    expect(res.json()).toStrictEqual({
      vaultId: plane.boot.vaultId,
      keyId: live.keyId,
      key: live.key.toString("base64"),
      algorithm: "aes-256-gcm",
    });
    // A proxy or a service worker holding `K` would be a second copy of the
    // key in a place nothing revokes.
    expect(res.getHeader("cache-control")).toBe("no-store");
  });

  test("a revoked device is refused the key, and the ticket never carried it", async () => {
    const { plane, unscoped, enrollments, deviceKey } = await fixture();
    enrollments.revoke(deviceKey);
    const res = new MockResponse();
    await runWithVaultContext({ vaultId: plane.boot.vaultId, deviceKey }, () =>
      unscoped(request(SEAT_LOCKER_KEY_PATH), res as unknown as ServerResponse)
    );
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "replica_device_not_enrolled" });

    // AND THE OTHER HALF OF R13: the pairing ticket has no room for `K` and is
    // never given one. Revoking a device would mean nothing if the key had
    // ridden a QR payload that outlives the glance in a photo roll.
    const ticket = parsePairingTicket(
      encodePairingTicket({
        v: 1,
        kind: "centraid-gw-pair",
        gw: "https://home.example",
        t: "ticket-1",
        s: "secret-1",
        vaultName: "Home",
        exp: 1,
      })
    );
    expect(Object.keys(ticket ?? {}).toSorted()).toStrictEqual([
      "exp",
      "gw",
      "kind",
      "s",
      "t",
      "v",
      "vaultName",
    ]);
  });

  test("the log door serves whole commits, bounded, with its cursor", async () => {
    const { plane, handler } = await fixture();
    note(plane, "a", "A");
    note(plane, "b", "B");
    const res = new MockResponse();
    await handler(
      request(`${SEAT_LOG_PATH}?since=0&limit=1`),
      res as unknown as ServerResponse
    );
    expect(res.statusCode).toBe(200);
    const page = res.json<{
      epoch: string;
      schemaEpoch: number;
      rows: { seq: number; commitSeq: number; table: string; pk: unknown[] }[];
      next: number;
      hasMore: boolean;
      watermark: number;
    }>();
    // ASSERTED AGAINST THE CONSTANT, not a copy of its value: #996 W5 bumped
    // the epoch 2 -> 3 and these two pins were the only things left saying 2.
    expect(page.schemaEpoch).toBe(REPLICA_SCHEMA_EPOCH);
    // The limit was one; the page carries the whole first commit anyway.
    expect(page.rows.length).toBeGreaterThan(1);
    const first = page.rows[0]!.commitSeq;
    expect(page.rows.every((row) => row.commitSeq === first)).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(page.rows.some((row) => row.table === "core_concept_scheme")).toBe(
      true
    );

    const rest = new MockResponse();
    await handler(
      request(`${SEAT_LOG_PATH}?since=${page.next}&limit=1000`),
      rest as unknown as ServerResponse
    );
    const tail = rest.json<{
      rows: { commitSeq: number }[];
      hasMore: boolean;
    }>();
    expect(tail.rows.every((row) => row.commitSeq !== first)).toBe(true);
    expect(tail.hasMore).toBe(false);
  });

  test("every seat door answer leaves a line in the gateway log", async () => {
    // WHY THIS IS A TEST AND NOT A CONVENIENCE (#1011). A phone that never
    // caught up left NO trace: the log door only reads, and the snapshot door
    // only writes the first time a watermark is asked for. "Did this seat ever
    // ask?" was unanswerable from the gateway's own logs, which is where
    // docs/logs.md sends every debug session first.
    const lines: string[] = [];
    const dir = await tempDir(`seat-routes-log-${crypto.randomUUID()}-`);
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger,
      enableWalShipper: false,
    });
    const enrollments = EnrollmentStore.open(path.join(dir, "gateway.db"));
    const deviceKey = "seat-device";
    enrollments.enroll({
      endpointId: deviceKey,
      vaultIds: [plane.boot.vaultId],
      label: "Seat",
      rememberDevice: true,
    });
    cleanups.push(
      () => fs.rm(dir, { recursive: true, force: true }),
      () => plane.stop()
    );
    const handler = makeSeatRouteHandler(
      { current: () => plane } as unknown as VaultRegistry,
      {
        enrollments,
        logger: { ...logger, info: (message) => lines.push(message) },
      }
    );
    note(plane, "a", "A");
    const res = new MockResponse();
    await runWithVaultContext({ vaultId: plane.boot.vaultId, deviceKey }, () =>
      handler(
        request(`${SEAT_LOG_PATH}?since=0&limit=1000`),
        res as unknown as ServerResponse
      )
    );
    expect(res.statusCode).toBe(200);
    const served = lines.find((line) => line.startsWith("seat log page"));
    expect(served).toContain(plane.boot.vaultId);
    expect(served).toContain("since 0");
    expect(served).toMatch(/\d+ rows/u);

    const snapshot = new MockResponse();
    await runWithVaultContext({ vaultId: plane.boot.vaultId, deviceKey }, () =>
      handler(
        request(SEAT_SNAPSHOT_PATH),
        snapshot as unknown as ServerResponse
      )
    );
    expect(snapshot.statusCode).toBe(200);
    expect(lines.some((line) => line.startsWith("seat snapshot"))).toBe(true);
  });

  test("the log door refuses a bad bound and a stale cursor", async () => {
    const { plane, handler } = await fixture();
    note(plane, "a", "A");

    const bad = new MockResponse();
    await handler(
      request(`${SEAT_LOG_PATH}?limit=0`),
      bad as unknown as ServerResponse
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_seat_log_limit" });

    const ahead = new MockResponse();
    await handler(
      request(`${SEAT_LOG_PATH}?since=999999`),
      ahead as unknown as ServerResponse
    );
    // START OVER, SAID OUT LOUD — never a page that is silently short.
    expect(ahead.statusCode).toBe(409);
    expect(ahead.json()).toMatchObject({
      error: "seat_rebootstrap_required",
      reason: "cursor-ahead",
      snapshot: SEAT_SNAPSHOT_PATH,
    });

    const foreign = new MockResponse();
    await handler(
      request(`${SEAT_LOG_PATH}?epoch=another-contract&since=0`),
      foreign as unknown as ServerResponse
    );
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json()).toMatchObject({ reason: "epoch-mismatch" });
  });

  test("the snapshot door serves a resumable, revalidatable file", async () => {
    const { plane, handler } = await fixture();
    note(plane, "a", "A");

    const full = new MockResponse();
    await handler(
      request(SEAT_SNAPSHOT_PATH),
      full as unknown as ServerResponse
    );
    expect(full.statusCode).toBe(200);
    expect(full.getHeader("accept-ranges")).toBe("bytes");
    const etag = full.getHeader("etag")!;
    expect(etag).toContain(String(full.getHeader("x-centraid-seat-seq")));
    expect(full.getHeader("x-centraid-schema-epoch")).toBe(
      String(REPLICA_SCHEMA_EPOCH)
    );
    // It really is the vault: gunzip it and the private tables are gone.
    const bytes = gunzipSync(full.body);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 15).toString("utf8")).toBe("SQLite format 3");
    expect(bytes.indexOf(Buffer.from("access_device_secret"))).toBe(-1);
    expect(bytes.indexOf(Buffer.from("core_concept_scheme"))).toBeGreaterThan(
      -1
    );

    // Revalidation: the artifact is immutable for its name.
    const cached = new MockResponse();
    await handler(
      request(SEAT_SNAPSHOT_PATH, { "if-none-match": etag }),
      cached as unknown as ServerResponse
    );
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toHaveLength(0);

    // Resumption: the second half of an interrupted download.
    const half = Math.floor(full.body.length / 2);
    const resumed = new MockResponse();
    await handler(
      request(SEAT_SNAPSHOT_PATH, { range: `bytes=${half}-` }),
      resumed as unknown as ServerResponse
    );
    expect(resumed.statusCode).toBe(206);
    expect(resumed.getHeader("content-range")).toBe(
      `bytes ${half}-${full.body.length - 1}/${full.body.length}`
    );
    expect(
      Buffer.concat([full.body.subarray(0, half), resumed.body]).equals(
        full.body
      )
    ).toBe(true);

    const bad = new MockResponse();
    await handler(
      request(SEAT_SNAPSHOT_PATH, { range: "bytes=99999999-" }),
      bad as unknown as ServerResponse
    );
    expect(bad.statusCode).toBe(416);
  });

  test("the snapshot's seq is the position the log tail continues from", async () => {
    const { plane, handler } = await fixture();
    note(plane, "a", "A");
    const snap = new MockResponse();
    await handler(
      request(SEAT_SNAPSHOT_PATH),
      snap as unknown as ServerResponse
    );
    const seq = Number(snap.getHeader("x-centraid-seat-seq"));
    note(plane, "b", "B");
    const tail = new MockResponse();
    await handler(
      request(`${SEAT_LOG_PATH}?since=${seq}&limit=1000`),
      tail as unknown as ServerResponse
    );
    const page = tail.json<{ rows: { seq: number; row?: unknown }[] }>();
    // Everything after the file, and nothing already in it.
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((row) => row.seq > seq)).toBe(true);
  });

  /**
   * A plane-shaped stand-in over a vault this test opened itself.
   *
   * The two corpora that matter — 0e's thirteen scenarios and the frozen
   * golden vault — are BUILT vaults, not vaults a `VaultPlane` bootstrapped,
   * and a fresh plane is exactly what would overwrite them. The doors read
   * three things off a plane, so this supplies those three and nothing else.
   */
  async function doorsOver(
    open: (dir: string) => { vault: ReturnType<typeof openVaultDb>["vault"] },
    vaultId: string
  ): Promise<{
    handler: ReturnType<typeof makeSeatRouteHandler>;
    dir: string;
  }> {
    const dir = await tempDir(`seat-corpus-${crypto.randomUUID()}-`);
    const db = open(dir);
    const enrollments = EnrollmentStore.open(path.join(dir, "gateway.db"));
    const deviceKey = "corpus-seat";
    enrollments.enroll({
      endpointId: deviceKey,
      vaultIds: [vaultId],
      label: "Seat",
      rememberDevice: true,
    });
    const plane = {
      db,
      dir,
      boot: { vaultId },
    } as unknown as VaultPlane;
    const unscoped = makeSeatRouteHandler(
      { current: () => plane } as unknown as VaultRegistry,
      { enrollments }
    );
    cleanups.push(
      () => fs.rm(dir, { recursive: true, force: true }),
      () => db.vault.close()
    );
    return {
      dir,
      handler: (req, res) =>
        runWithVaultContext({ vaultId, deviceKey }, () => unscoped(req, res)),
    };
  }

  async function assertDoorsServe(
    handler: ReturnType<typeof makeSeatRouteHandler>,
    label: string
  ): Promise<void> {
    const log = new MockResponse();
    await handler(
      request(`${SEAT_LOG_PATH}?since=0&limit=10000`),
      log as unknown as ServerResponse
    );
    expect(log.statusCode, label).toBe(200);
    const page = log.json<{ rows: { table: string }[]; watermark: number }>();

    const snap = new MockResponse();
    await handler(
      request(SEAT_SNAPSHOT_PATH),
      snap as unknown as ServerResponse
    );
    expect(snap.statusCode, label).toBe(200);
    // The file's position IS the log's watermark — that identity is what lets
    // a seat bootstrap from the file and tail from the number beside it.
    expect(Number(snap.getHeader("x-centraid-seat-seq")), label).toBe(
      page.watermark
    );
    const bytes = gunzipSync(snap.body);
    expect(bytes.subarray(0, 15).toString("utf8"), label).toBe(
      "SQLite format 3"
    );
    expect(bytes.indexOf(Buffer.from("access_device_secret")), label).toBe(-1);
  }

  test("the doors answer over the 0e ontology fixture", async () => {
    // The corpus every convergence test replays: thirteen scenarios across
    // People, Tasks, Docs, Agenda and Tally, written through the real command
    // pipeline. The doors have to serve a vault with real rows in it.
    const fixtureVault = buildOntologyScenarios();
    const vaultId = (
      fixtureVault.db.vault
        .prepare(`SELECT vault_id FROM core_vault LIMIT 1`)
        .get() as { vault_id: string }
    ).vault_id;
    const { handler } = await doorsOver(() => fixtureVault.db, vaultId);
    const page = new MockResponse();
    await handler(
      request(`${SEAT_LOG_PATH}?since=0&limit=10000`),
      page as unknown as ServerResponse
    );
    const rows = page.json<{ rows: { table: string }[] }>().rows;
    expect(rows.length).toBeGreaterThan(0);
    // Many tables, not one: a decoder that dropped a table would still pass a
    // single-table assertion.
    expect(new Set(rows.map((row) => row.table)).size).toBeGreaterThan(5);
    await assertDoorsServe(handler, "0e fixture");
  });

  test("the doors answer over the frozen golden vault", async () => {
    const goldenRoot = path.resolve(
      import.meta.dirname,
      "../../../vault/tests/golden/issue-929"
    );
    const { handler } = await doorsOver((dir) => {
      writeFileSync(
        path.join(dir, "vault.db"),
        gunzipSync(readFileSync(path.join(goldenRoot, "vault.db.gz")))
      );
      // Opening runs the ladder, exactly as the golden gate does — the
      // corpus is prior-release evidence and the doors must serve it after
      // this build has migrated it.
      return openVaultDb({ dir });
    }, "golden");
    expect(handler).toBeTypeOf("function");
    await assertDoorsServe(handler, "golden issue-929");
  });
});

describe(parseByteRange, () => {
  test("reads the forms a resumed download actually sends", () => {
    expect(parseByteRange(undefined, 100)).toBeUndefined();
    expect(parseByteRange("bytes=0-9", 100)).toStrictEqual({
      start: 0,
      end: 9,
    });
    expect(parseByteRange("bytes=50-", 100)).toStrictEqual({
      start: 50,
      end: 99,
    });
    // A suffix range is the LAST n bytes, not the first n.
    expect(parseByteRange("bytes=-10", 100)).toStrictEqual({
      start: 90,
      end: 99,
    });
    // Clamped rather than refused: asking past the end of a file you are
    // resuming is what a client with a stale length does.
    expect(parseByteRange("bytes=90-200", 100)).toStrictEqual({
      start: 90,
      end: 99,
    });
  });

  test("refuses what it cannot answer, rather than guessing", () => {
    expect(parseByteRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=20-10", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=-", 100)).toBe("unsatisfiable");
    expect(parseByteRange("items=0-9", 100)).toBe("unsatisfiable");
    // Multipart ranges are legal HTTP and no seat needs them; refusing is
    // honest, emitting a wrong multipart body is not.
    expect(parseByteRange("bytes=0-9,20-29", 100)).toBe("unsatisfiable");
  });
});
