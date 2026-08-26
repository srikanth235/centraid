import { describe, expect, it } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { carryLoadedBodies, coalesceByKey } from "./draft-writes.ts";
import { note } from "./logic.test-fixtures.ts";

describe("a loaded body survives a preview-only window", () => {
  it("keeps a loaded body when the next window only has a preview", () => {
    const next = carryLoadedBodies(
      [note({ note_id: "n1", body: "the whole note", preview: "the whole" })],
      [note({ note_id: "n1", preview: "the whole", pinned: 1 })]
    );
    expect(next[0]?.body).toBe("the whole note");
    expect(next[0]?.pinned).toBe(1);
  });

  it("does not invent a body the editor never held", () => {
    expect(
      carryLoadedBodies(
        [note({ note_id: "n1", preview: "first line" })],
        [note({ note_id: "n1", preview: "first line" })]
      )[0]?.body
    ).toBeUndefined();
  });
});

describe("a keyed debounce flushes the previous note immediately", () => {
  it("flushes the previous key immediately when the next one is different", async () => {
    const clock = useFakeClock();
    const seen: string[] = [];
    const { run } = coalesceByKey(
      (id: string) => {
        seen.push(id);
      },
      (id) => id,
      600
    );
    run("n1");
    run("n2");
    expect(seen).toStrictEqual(["n1"]);
    await clock.advance(600);
    expect(seen).toStrictEqual(["n1", "n2"]);
  });

  it("merges successive patches for the same key so a title is not dropped", async () => {
    const clock = useFakeClock();
    const seen: Array<{ title?: string; body_text?: string }> = [];
    const { run, flush } = coalesceByKey(
      (_id: string, patch: { title?: string; body_text?: string }) => {
        seen.push(patch);
      },
      (id) => id,
      600,
      (previous, next) => [previous[0], { ...previous[1], ...next[1] }]
    );
    run("n1", { title: "Lease terms" });
    run("n1", { body_text: "The deposit clause" });
    await clock.advance(600);
    await flush();
    expect(seen).toStrictEqual([
      { title: "Lease terms", body_text: "The deposit clause" },
    ]);
  });
});
