// THE SNAPSHOT CACHE, AND THE SEAT THAT PINS AN ARTIFACT IN IT (#1014, V4/V19).
//
// The door builds for the CURRENT watermark and this gateway is never
// quiescent — the system recognition automations write their conversation
// ledger on every boot and those rows replicate — so a phone that HEADed one
// seq and then asked for bytes got another, `If-Range` refused the resume, and
// on a slow enough connection the bootstrap never landed. These cases hold the
// two halves of the answer: the door serves the seq a seat names while it
// still holds it, and the cache evicts by SEQ rather than by the hash prefix
// its filenames happen to sort on.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { beginReplicaCommit, endReplicaCommit } from "@centraid/vault";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { runWithVaultContext } from "../serve/vault-context.js";
import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { makeSeatRouteHandler, SEAT_SNAPSHOT_PATH } from "./seat-routes.js";
import { MockResponse } from "./seat-routes.test-fixtures.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

describe("the seat snapshot cache", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function fixture(): Promise<{
    plane: VaultPlane;
    handler: ReturnType<typeof makeSeatRouteHandler>;
    enrollments: EnrollmentStore;
    deviceKey: string;
  }> {
    const dir = await tempDir(`seat-cache-${crypto.randomUUID()}-`);
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
    return { plane, handler, enrollments, deviceKey };
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
  function note(plane: VaultPlane, id: string, title: string): void {
    plane.db.vault.exec("BEGIN");
    const handle = beginReplicaCommit(plane.db.vault, { producer: "test" });
    try {
      plane.db.vault
        .prepare(
          `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
           VALUES (?, ?, ?, '1')`
        )
        .run(id, `urn:${id}`, title);
      endReplicaCommit(plane.db.vault, handle);
      plane.db.vault.exec("COMMIT");
    } catch (error) {
      plane.db.vault.exec("ROLLBACK");
      throw error;
    }
  }

  test("a pinned seq keeps a slow download on the artifact it measured", async () => {
    // THE GATEWAY IS NEVER QUIESCENT (#1014, V4). The recognition automations
    // write their conversation ledger on every boot and those rows replicate,
    // so "the door built for the current watermark" means a phone that
    // measured seq N asks for bytes and is handed seq N+1 — which `If-Range`
    // correctly refuses, and which no amount of retrying escapes.
    const { plane, handler } = await fixture();
    note(plane, "a", "A");

    const head = new MockResponse();
    await handler(
      Object.assign(request(SEAT_SNAPSHOT_PATH), { method: "HEAD" }),
      head as unknown as ServerResponse
    );
    const measured = String(head.getHeader("x-centraid-seat-seq"));
    const measuredEtag = head.getHeader("etag")!;

    // The vault moves on, exactly as it does under a live gateway.
    note(plane, "b", "B");

    const unpinned = new MockResponse();
    await handler(
      request(SEAT_SNAPSHOT_PATH),
      unpinned as unknown as ServerResponse
    );
    expect(
      unpinned.getHeader("etag"),
      "the door served the same artifact after a commit, so this test proves nothing"
    ).not.toBe(measuredEtag);

    const pinned = new MockResponse();
    await handler(
      request(`${SEAT_SNAPSHOT_PATH}?seq=${measured}`),
      pinned as unknown as ServerResponse
    );
    expect(pinned.statusCode).toBe(200);
    expect(pinned.getHeader("etag")).toBe(measuredEtag);
    expect(pinned.getHeader("x-centraid-seat-seq")).toBe(measured);

    // And a resume against the pin is a resume of THAT file, which is the
    // whole point: the bytes splice onto the prefix the phone already has.
    const half = Math.floor(pinned.body.length / 2);
    const resumed = new MockResponse();
    await handler(
      request(`${SEAT_SNAPSHOT_PATH}?seq=${measured}`, {
        range: `bytes=${half}-`,
      }),
      resumed as unknown as ServerResponse
    );
    expect(resumed.statusCode).toBe(206);
    expect(resumed.getHeader("etag")).toBe(measuredEtag);
    expect(
      Buffer.concat([pinned.body.subarray(0, half), resumed.body]).equals(
        pinned.body
      )
    ).toBe(true);
  });

  test("a pin the cache no longer holds falls back to the current artifact", async () => {
    // A HINT, NEVER A DEMAND (#1014, V4). The client's bounded re-HEAD is what
    // covers this; a 404 here would turn a slow phone into a stuck one, and a
    // gateway older than #1014 ignores the parameter outright anyway.
    const { plane, handler } = await fixture();
    note(plane, "a", "A");
    const current = new MockResponse();
    await handler(
      request(`${SEAT_SNAPSHOT_PATH}?seq=999999`),
      current as unknown as ServerResponse
    );
    expect(current.statusCode).toBe(200);
    expect(current.getHeader("etag")).toContain(
      String(current.getHeader("x-centraid-seat-seq"))
    );

    // Nonsense is the same answer, not a 400: the seat has nothing to do with
    // a refusal here that it does not already do with a moved artifact.
    const junk = new MockResponse();
    await handler(
      request(`${SEAT_SNAPSHOT_PATH}?seq=not-a-number`),
      junk as unknown as ServerResponse
    );
    expect(junk.statusCode).toBe(200);
  });

  test("the cache evicts by seq, oldest first, and keeps the newest few", async () => {
    // THE NAME SORTS BY ITS HASH, NOT BY ITS POSITION (#1014, V19). Eviction
    // used to sort the directory listing lexically over `snapshot-<hash>-<seq>`,
    // so "keep the newest two" kept two arbitrary ones — including, sometimes,
    // deleting the artifact a phone was resuming while keeping one nobody had.
    const { plane, enrollments, deviceKey } = await fixture();
    const vaults = { current: () => plane } as unknown as VaultRegistry;
    const dir = path.join(plane.dir, "seat-cache");
    const pinnable = makeSeatRouteHandler(vaults, {
      enrollments,
      snapshotDir: dir,
      snapshotCacheSize: 2,
    });
    const seqs: string[] = [];
    for (const id of ["a", "b", "c", "d"]) {
      note(plane, id, id.toUpperCase());
      const res = new MockResponse();
      // oxlint-disable-next-line no-await-in-loop
      await runWithVaultContext(
        { vaultId: plane.boot.vaultId, deviceKey },
        () =>
          pinnable(
            request(SEAT_SNAPSHOT_PATH),
            res as unknown as ServerResponse
          )
      );
      seqs.push(String(res.getHeader("x-centraid-seat-seq")));
    }
    const kept = (await fs.readdir(dir))
      .filter((name) => name.endsWith(".db.gz"))
      .map((name) => name.slice(name.lastIndexOf("-") + 1, -".db.gz".length))
      .sort((a, b) => Number(a) - Number(b));
    expect(kept).toStrictEqual(seqs.slice(-2));
  });
});
