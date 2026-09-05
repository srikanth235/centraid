import { describe, expect, it } from "vitest";

import type { ReplicaInvalidation } from "../../replica/types.js";
import { collapseInlineChanges } from "./inline-change-batch.js";

// ONE APPLIED BATCH IS ONE CHANGE EVENT (#922 D1). The counter this suite
// keeps is the number of change events an app receives for one `applyChanges`:
// it used to be the number of invalidations in the batch, which is the number
// of rows a reconnect touched, which is unbounded.

const NOW = 1_700_000_000_000;

function canonical(entity: string): ReplicaInvalidation {
  return { shapeId: "s", entity, source: "canonical" };
}

describe("inline change batch", () => {
  it("collapses one applied batch into one event per source", () => {
    const batch = [
      canonical("schedule.task"),
      canonical("schedule.task"),
      canonical("core.party"),
      canonical("schedule.task"),
    ];
    const events = collapseInlineChanges(batch, "own", NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.tables).toStrictEqual(["schedule.task", "core.party"]);
    expect(events[0]?.source).toBe("canonical");
    expect(events[0]?.scope).toBe("own");
  });

  it("forty edits settling still cost one row event, not forty", () => {
    const batch = Array.from({ length: 40 }, () => canonical("schedule.task"));
    expect(collapseInlineChanges(batch, "own", NOW)).toHaveLength(1);
  });

  // The wildcard is the "everything here may have moved" channel, and an empty
  // table list is what `onDataChange` fires on unconditionally: a named entity
  // beside it must not narrow the event back down to that entity.
  it("a wildcard in the batch collapses the whole source to the wildcard", () => {
    const events = collapseInlineChanges(
      [
        canonical("schedule.task"),
        { shapeId: "*", entity: "*", source: "purge" },
      ],
      "own",
      NOW
    );
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.source)).toStrictEqual([
      "canonical",
      "purge",
    ]);
    expect(events[1]?.tables).toStrictEqual([]);
  });

  // The owner's own write is not a batch to merge: each intent's transition is
  // narrated, and it goes out with nothing between it and the read.
  it("keeps one event per settling intent, after the rows", () => {
    const events = collapseInlineChanges(
      [
        canonical("schedule.task"),
        {
          shapeId: "s",
          entity: "schedule.task",
          source: "overlay",
          intentId: "intent-a",
          intentState: "executed",
        },
        {
          shapeId: "s",
          entity: "schedule.task",
          source: "overlay",
          intentId: "intent-b",
          intentState: "queued",
        },
      ],
      "own",
      NOW
    );
    expect(events).toHaveLength(3);
    expect(events[0]?.source).toBe("canonical");
    expect(events.slice(1).map((event) => event.intentId)).toStrictEqual([
      "intent-a",
      "intent-b",
    ]);
    expect(events[1]?.intentState).toBe("executed");
  });

  it("carries the batch's own timestamp, never a fresh clock read per event", () => {
    const events = collapseInlineChanges(
      [canonical("schedule.task"), canonical("core.party")],
      "own",
      NOW
    );
    expect(events.map((event) => event.ts)).toStrictEqual([NOW]);
  });
});
