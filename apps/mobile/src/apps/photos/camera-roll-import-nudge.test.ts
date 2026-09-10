// The post-publish seat nudge (#1011 M2): the owner's own import shows up in
// their library in seconds, without a poll. One nudge per BATCH, and only when
// the batch actually published something.
import { describe, expect, it, vi } from "vitest";

// The batch is pure routing (`camera-roll-import.ts`), so this file needs
// none of the device seams the real door pulls in (#1014).
import { EMPTY_IMPORT_PROGRESS, runImportBatch } from "./camera-roll-import";
import type { ImportCandidate, ImportOutcome } from "./camera-roll-import";

function candidate(id: string): ImportCandidate {
  return { id, localId: `local-${id}`, filename: `${id}.HEIC`, kind: "photo" };
}

async function run(
  outcomes: Record<string, ImportOutcome | "throw">
): Promise<ReturnType<typeof vi.fn<() => void>>> {
  const nudgeSeat = vi.fn<() => void>();
  await runImportBatch(
    Object.keys(outcomes).map(candidate),
    EMPTY_IMPORT_PROGRESS,
    {
      nudgeSeat,
      attempt: (item: ImportCandidate) => {
        const outcome = outcomes[item.id]!;
        if (outcome === "throw") return Promise.reject(new Error("boom"));
        return Promise.resolve(outcome);
      },
    }
  );
  return nudgeSeat;
}

describe(runImportBatch, () => {
  it("nudges the seat exactly ONCE for a batch that published several photographs", async () => {
    const nudgeSeat = await run({ a: "imported", b: "imported", c: "skipped" });
    expect(nudgeSeat).toHaveBeenCalledOnce();
  });

  it("nudges once for a batch with a single published item", async () => {
    const nudgeSeat = await run({ a: "imported" });
    expect(nudgeSeat).toHaveBeenCalledOnce();
  });

  it("does not nudge when every candidate failed — no row is coming", async () => {
    const nudgeSeat = await run({ a: "throw", b: "throw" });
    expect(nudgeSeat).not.toHaveBeenCalled();
  });

  it("does not nudge when every candidate was a dedupe skip", async () => {
    const nudgeSeat = await run({ a: "skipped", b: "skipped" });
    expect(nudgeSeat).not.toHaveBeenCalled();
  });

  it("still returns the honest progress the offer persists", async () => {
    const result = await runImportBatch(
      [candidate("a"), candidate("b")],
      EMPTY_IMPORT_PROGRESS,
      {
        nudgeSeat: () => undefined,
        attempt: (item: ImportCandidate) =>
          item.id === "a"
            ? Promise.resolve<ImportOutcome>("imported")
            : Promise.reject(new Error("boom")),
      }
    );
    expect(result.imported).toBe(1);
    expect(Object.keys(result.failed)).toStrictEqual(["b"]);
  });
});
