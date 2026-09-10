import { describe, expect, it } from "vitest";

import { vaultEntityOfTable, vaultPhysicalTable } from "../vault-tables.js";
import {
  seatChangeInvalidations,
  seatPurgeInvalidation,
} from "./invalidations.js";

function notice(tables: string[]): {
  tables: string[];
  cursor: number;
  commitSeqs: number[];
} {
  return { tables, cursor: 1, commitSeqs: [1] };
}

describe("a seat's change notice, as invalidations", () => {
  it("names the entities whose tables the batch wrote", () => {
    expect(
      seatChangeInvalidations(notice(["schedule_task", "core_party"]))
    ).toStrictEqual([
      { entity: "schedule.task", source: "canonical" },
      { entity: "core.party", source: "canonical" },
    ]);
  });

  it("splits on the FIRST underscore only", () => {
    // `media.asset_phash` is one entity. Splitting on every underscore would
    // invalidate `media.asset`, which is a different table with different rows.
    expect(vaultEntityOfTable("media_asset_phash")).toBe("media.asset_phash");
    expect(
      seatChangeInvalidations(notice(["media_asset_phash"]))
    ).toStrictEqual([{ entity: "media.asset_phash", source: "canonical" }]);
  });

  it("says nothing about the seat's own bookkeeping", () => {
    // `seat_state`'s cursor moves on EVERY applied page. Turning that into an
    // invalidation re-runs every read on screen for every page of a bootstrap.
    expect(
      seatChangeInvalidations(
        notice([
          "seat_state",
          "seat_outbox",
          "seat_outbox_settled",
          "replica_log",
          "replica_meta",
          "sqlite_sequence",
          "fts_schedule_task",
        ])
      )
    ).toStrictEqual([]);
  });

  it("de-duplicates an entity a batch touched twice", () => {
    expect(
      seatChangeInvalidations(notice(["core_party", "core_party"]))
    ).toHaveLength(1);
  });

  it("round-trips every physical name the read path composes", () => {
    for (const entity of [
      "schedule.task",
      "core.party",
      "knowledge.note",
      "core.content_item",
      "media.asset_phash",
      "tally.expense",
      // The ext band is three parts (#1014, G8): `ext.gym.workout` composes to
      // `ext_gym_workout`, and a screen watching a third-party app's own rows
      // has to be told when they move.
      "ext.gym.workout",
      "ext.gym.work_log",
      "extdraft.gym.workout",
    ])
      expect(vaultEntityOfTable(vaultPhysicalTable(entity))).toBe(entity);
  });

  it("composes an ext physical the way the vault does", () => {
    // `schema/ext.ts#extPhysical`: the band, then the app id with its hyphens
    // normalised, then the table. Replacing only the first dot named a table
    // that does not exist, and the seat's base-version read swallowed the
    // failure — so an ext row's write carried no precondition at all.
    expect(vaultPhysicalTable("ext.gym.workout")).toBe("ext_gym_workout");
    expect(vaultPhysicalTable("ext.my-app.workout")).toBe("ext_my_app_workout");
    expect(vaultPhysicalTable("extdraft.gym.workout")).toBe(
      "extdraft_gym_workout"
    );
  });

  it("a purge names no entity, because none of them survived", () => {
    expect(seatPurgeInvalidation()).toStrictEqual([
      { entity: "*", source: "purge" },
    ]);
  });
});
