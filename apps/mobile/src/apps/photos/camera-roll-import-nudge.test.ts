// The post-publish seat nudge (#1011 M2): the owner's own import shows up in
// their library in seconds, without a poll. One nudge per BATCH, and only when
// the batch actually published something.
import { describe, expect, it, vi } from "vitest";

import { EMPTY_IMPORT_PROGRESS } from "./camera-roll-import";
import type { ImportCandidate, ImportOutcome } from "./camera-roll-import";
import type * as TypeImport_deviceMedia from "./device-media";

// The module's network/device seams reach react-native, which this
// environment cannot parse. Every attempt here is INJECTED, so none of them
// runs — the same stubs `camera-roll-import-rungs.test.ts` installs.
vi.mock(import("expo-file-system"), () => ({}) as never);
vi.mock(import("../../lib/gateway"), () => ({ authHeader: () => ({}) }));
vi.mock(import("../../lib/upload/derivatives-native"), () => ({}) as never);
vi.mock(import("../../lib/upload/native-digest"), () => ({
  createNativeDigest: () => {
    throw new Error("no digest in this test");
  },
}));
vi.mock(import("./device-media"), () => ({
  openDeviceOriginal: (() =>
    Promise.reject(
      new Error("no device original in this test")
    )) as unknown as typeof TypeImport_deviceMedia.openDeviceOriginal,
  liveVideoUri: () => Promise.resolve(null),
}));

const { runImportBatchWithNudge } = await import("./camera-roll-import-run");

function candidate(id: string): ImportCandidate {
  return { id, localId: `local-${id}`, filename: `${id}.HEIC`, kind: "photo" };
}

async function run(
  outcomes: Record<string, ImportOutcome | "throw">
): Promise<ReturnType<typeof vi.fn<() => void>>> {
  const nudgeSeat = vi.fn<() => void>();
  await runImportBatchWithNudge(
    "http://gw",
    Object.keys(outcomes).map(candidate),
    EMPTY_IMPORT_PROGRESS,
    {
      nudgeSeat,
      attempt: (item) => {
        const outcome = outcomes[item.id]!;
        if (outcome === "throw") return Promise.reject(new Error("boom"));
        return Promise.resolve(outcome);
      },
    }
  );
  return nudgeSeat;
}

describe("runImportBatchWithNudge", () => {
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
    const result = await runImportBatchWithNudge(
      "http://gw",
      [candidate("a"), candidate("b")],
      EMPTY_IMPORT_PROGRESS,
      {
        nudgeSeat: () => undefined,
        attempt: (item) =>
          item.id === "a"
            ? Promise.resolve<ImportOutcome>("imported")
            : Promise.reject(new Error("boom")),
      }
    );
    expect(result.imported).toBe(1);
    expect(Object.keys(result.failed)).toStrictEqual(["b"]);
  });
});
