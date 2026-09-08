// THE 3.49.1 SEAT CHECK (#996 wave 3, ruling R-A2).
//
// The phone is the OLDEST SQLite in the system and the only seat whose version
// is chosen by a build flag rather than by a runtime: `useSQLCipher: true` on
// the expo-sqlite plugin swaps the vendored 3.50.3 for SQLCipher's 3.49.1. So
// "it works here" proves nothing — `node:sqlite` is 3.50.2 and sqlite-wasm is
// 3.53.0, and every construct newer than the floor passes on both.
//
// TWO HALVES, AND THIS FILE IS THE ONE THAT CAN RUN ON NODE. It asserts the
// DIALECT: the seat's DDL, the applier's statement and the FTS rebuild are
// expressible in 3.49. The other half — that the sanitised snapshot's DDL
// actually OPENS, that a JSON page applies and that the rebuild returns, on a
// SQLCipher build on a real device — cannot run in any node process. It runs
// in CI's `mobile-device-gate`, which compiles the Android tree under
// `assembleRelease` and RUNS the artifact under Maestro; `mobile-smoke`
// deliberately cannot answer it, because that job compiles and bundles and
// never executes the app.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  rebuildSeatFtsIndexes,
  SEAT_OPEN_PRAGMAS,
  SEAT_STATE_DDL,
} from "@centraid/client/replica/native";
import type {
  SeatBindValue,
  SeatSqliteDriver,
} from "@centraid/client/replica/native";
import { applyRowSql } from "@centraid/core/protocol";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");

/**
 * Every SQLite feature the seat plane could reach for that landed AFTER the
 * floor. Each entry is a construct that compiles on the gateway (3.50) and in
 * the browser (3.53) and is a syntax error on the phone.
 */
const ABOVE_THE_FLOOR: readonly { pattern: RegExp; since: string }[] = [
  { pattern: /\bconcat_ws\s*\(/iu, since: "3.44" },
  { pattern: /\bconcat\s*\(/iu, since: "3.44" },
  { pattern: /\boctet_length\s*\(/iu, since: "3.43" },
  { pattern: /\bunhex\s*\(/iu, since: "3.41" },
  { pattern: /\bjsonb_[a-z_]+\s*\(/iu, since: "3.45" },
  { pattern: /\bjson_valid\s*\([^()]*,/iu, since: "3.45 (two-argument form)" },
  { pattern: /\bRIGHT\s+(?:OUTER\s+)?JOIN\b/iu, since: "3.39" },
  { pattern: /\bFULL\s+(?:OUTER\s+)?JOIN\b/iu, since: "3.39" },
];

/** Every construct in `sql` that the phone's 3.49.1 cannot parse. */
const aboveTheFloor = (sql: string): string[] =>
  ABOVE_THE_FLOOR.filter(({ pattern }) => pattern.test(sql)).map(
    ({ pattern, since }) => `${pattern.source} (SQLite ${since})`
  );

class RecordingDriver implements SeatSqliteDriver {
  readonly statements: string[] = [];

  run(sql: string, _bind?: readonly SeatBindValue[]): void {
    this.statements.push(sql);
  }

  all<T extends object>(sql: string, _bind?: readonly SeatBindValue[]): T[] {
    this.statements.push(sql);
    return [{ name: "core_content_item_fts" }] as unknown as T[];
  }

  exec(sql: string): void {
    this.statements.push(sql);
  }

  close(): void {}
}

describe("the phone's SQLite floor", () => {
  it("is 3.49.1 because the build asks for SQLCipher, not because a runtime chose it", () => {
    const plugin = readFileSync(
      path.join(repoRoot, "apps/mobile/app.config.ts"),
      "utf8"
    );
    expect(plugin).toContain("useSQLCipher: true");
    // fts5 is not optional for a seat: the sanitised snapshot's only surviving
    // triggers are its FTS sync triggers, and the bootstrap rebuilds the index.
    expect(plugin).toContain("enableFTS: true");

    const floor = readFileSync(
      path.join(repoRoot, "packages/vault/src/schema/replica.ts"),
      "utf8"
    );
    expect(floor).toContain('export const SEAT_SQLITE_FLOOR = "3.49.1"');
  });

  it("keeps the seat's own DDL and open PRAGMAs inside the floor", () => {
    expect(aboveTheFloor(SEAT_STATE_DDL)).toStrictEqual([]);
    expect(aboveTheFloor(SEAT_OPEN_PRAGMAS.join(";\n"))).toStrictEqual([]);
  });

  it("keeps the applier's statement inside the floor, for every shape it emits", () => {
    // A composite key, a BLOB column and a wide-integer column: the three
    // shapes `row-json.ts` exists for, and the ones a narrower statement would
    // have been tempted to reach past the floor for.
    expect(
      aboveTheFloor(
        applyRowSql(
          "core_content_representation",
          ["item_id", "kind", "bytes", "byte_count"],
          ["item_id", "kind"]
        )
      )
    ).toStrictEqual([]);
    expect(
      aboveTheFloor(applyRowSql("core_entity", ["id", "kind"], ["id"]))
    ).toStrictEqual([]);
  });

  it("keeps the FTS rebuild inside the floor", () => {
    const driver = new RecordingDriver();
    expect(rebuildSeatFtsIndexes(driver)).toStrictEqual([
      "core_content_item_fts",
    ]);
    expect(aboveTheFloor(driver.statements.join(";\n"))).toStrictEqual([]);
  });
});
