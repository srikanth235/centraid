// ONE snapshot artifact for the seat suites.
//
// `carry-over.test.ts`, `worker-core.test.ts` and `web-seat.test.ts` all
// bootstrap a seat off the same one-table gateway file served from memory.
// They each spelled the database, the gzip and the door out for themselves;
// the file the three of them bootstrap from now has one spelling, so a change
// to the artifact is a change to the artifact rather than to three rigs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";

import { staticSeatSnapshotTransport } from "@centraid/test-kit/seat-snapshot-transport";

import type { SeatSnapshotTransport } from "./bootstrap.js";

/** The gateway's file, gzipped exactly as the snapshot door serves it. */
export function seatArtifact(root: string): Uint8Array {
  const source = path.join(root, "source.db");
  const db = new DatabaseSync(source);
  db.exec(`
    CREATE TABLE note (note_id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;
    INSERT INTO note VALUES ('n1', 'from the gateway');
  `);
  db.close();
  return gzipSync(readFileSync(source));
}

/** That artifact behind a snapshot door, at epoch `e1` and schema epoch 2. */
export function seatArtifactTransport(
  bytes: Uint8Array,
  seq: number
): SeatSnapshotTransport {
  return staticSeatSnapshotTransport(bytes, {
    seq,
    epoch: "e1",
    schemaEpoch: 2,
  });
}
