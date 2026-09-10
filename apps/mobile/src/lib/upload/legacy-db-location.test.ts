// #1014 R19: the durable upload ledger opened at a percent-encoded path on
// iOS, so the queue a member was waiting on lived in a file nothing else read.
import { describe, expect, it } from "vitest";

import {
  legacyEncodedDatabaseDirectory,
  planLegacyDatabaseMove,
} from "./legacy-db-location";

const IOS =
  "/var/mobile/Containers/Library/Application Support/CentraidReplica";
const ENCODED =
  "/var/mobile/Containers/Library/Application%20Support/CentraidReplica";
const NAME = "centraid-uploads.db";

function fs(...paths: string[]): (path: string) => boolean {
  const present = new Set(paths);
  return (path) => present.has(path);
}

describe("the stranded upload ledger", () => {
  it("names the encoded spelling of a path that has one", () => {
    expect(legacyEncodedDatabaseDirectory(IOS)).toBe(ENCODED);
  });

  it("has nothing to say about a path with nothing to escape", () => {
    const android = "/data/user/0/dev.centraid/no_backup/CentraidReplica";
    expect(legacyEncodedDatabaseDirectory(android)).toBeUndefined();
    expect(planLegacyDatabaseMove(android, NAME, fs())).toStrictEqual([]);
  });

  it("moves the stranded ledger and its WAL sidecars", () => {
    expect(
      planLegacyDatabaseMove(
        IOS,
        NAME,
        fs(`${ENCODED}/${NAME}`, `${ENCODED}/${NAME}-wal`)
      )
    ).toStrictEqual([
      { from: `${ENCODED}/${NAME}`, to: `${IOS}/${NAME}` },
      { from: `${ENCODED}/${NAME}-wal`, to: `${IOS}/${NAME}-wal` },
    ]);
  });

  // The ledger at the right place holds the rows this process is about to
  // use; overwriting it with an older stranded copy would LOSE queued uploads
  // rather than recover them.
  it("never overwrites a ledger that is already in the right place", () => {
    expect(
      planLegacyDatabaseMove(
        IOS,
        NAME,
        fs(`${ENCODED}/${NAME}`, `${IOS}/${NAME}`)
      )
    ).toStrictEqual([]);
  });

  it("does nothing when the old spelling left no file", () => {
    expect(planLegacyDatabaseMove(IOS, NAME, fs())).toStrictEqual([]);
  });
});
