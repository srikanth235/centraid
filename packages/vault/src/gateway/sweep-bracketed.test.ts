// THE SWEEP REACHES A SEAT (#1014, G5) — and so does the failure path (G24).
//
// Both used to mutate replicated tables with no commit pair open. The first
// sweep after process start lost its rows outright; a later one was absorbed
// into the next member command's commit and shipped under that producer.

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { readReplicaLog } from "../replica/log.js";
import { createGateway } from "./gateway.js";
import type { Gateway } from "./gateway.js";
import type { Credential } from "./types.js";

let db: VaultDb;
let gw: Gateway;
let owner: Credential;
let ownerPartyId: string;

describe("the standing sweep writes inside the commit pair", () => {
  beforeEach(() => {
    const booted = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Priya" }
    );
    db = booted.db;
    gw = createGateway(db);
    ownerPartyId = booted.boot.ownerPartyId;
    owner = {
      kind: "device",
      deviceId: booted.boot.deviceId,
      deviceKey: booted.boot.deviceKey,
    };
  });

  test("a purged note's delete is in replica_log, produced by the sweep", () => {
    const past = "2020-01-01T00:00:00.000Z";
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, content_uri, sha256, byte_size, created_at)
         VALUES ('body-1', 'data:text/plain,x', '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881', 1, ?)`
      )
      .run(past);
    db.vault
      .prepare(
        `INSERT INTO knowledge_note (note_id, author_party_id, title, body_content_id, format, pinned, created_at, updated_at, deleted_at, purge_at)
         VALUES ('n-lapsed', ?, 'Lapsed', 'body-1', 'plain', 0, ?, ?, ?, ?)`
      )
      .run(ownerPartyId, past, past, past, past);

    // FIRST sweep after process start — the case that lost rows outright.
    const result = gw.sweep(owner);
    expect(result.notesPurged).toBe(1);

    const rows = readReplicaLog(db.vault).rows;
    const noteDelete = rows.find(
      (row) => row.table === "knowledge_note" && row.op === "delete"
    );
    expect(noteDelete).toBeDefined();
    expect(noteDelete?.primaryKey[0]).toBe("n-lapsed");
    expect(noteDelete?.producer).toBe("sweep");
    // The sweep's own receipt replicates too, and it is in the tail's pair.
    expect(
      rows.some(
        (row) => row.table === "access_receipt" && row.producer === "sweep"
      )
    ).toBe(true);
  });

  test("a sweep that purges nothing still leaves the log consistent", () => {
    gw.sweep(owner);
    const before = readReplicaLog(db.vault).rows.length;
    gw.sweep(owner);
    // Only the second sweep's own receipt; no rows attributed to a later
    // producer, and nothing lost.
    expect(readReplicaLog(db.vault).rows.length).toBeGreaterThan(before);
    expect(db.vault.isTransaction).toBe(false);
  });
});
