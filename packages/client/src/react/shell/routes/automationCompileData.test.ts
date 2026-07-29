import { describe, expect, it, vi } from "vitest";

import {
  listAutomationTurns,
  readAutomationTurnExpanded,
  streamAutomationTurn,
} from "../../../gateway-client.js";
import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import {
  compileAttemptOf,
  compileStepOf,
  compileSteps,
  loadCompileAttempts,
  loadTurnSteps,
  watchTurnSteps,
} from "./automationCompileData.js";

// `automationCompileData.ts` imports the gateway-client barrel; stub it so
// pulling the module in doesn't run gateway-client-core's load-time
// `window.CentraidApi` side effect (same guard automationsData.test.ts uses).
vi.mock(import("../../../gateway-client.js"), () => ({
  listAutomationTurns: vi.fn<typeof TypeImport_1gl5zx7.listAutomationTurns>(),
  readAutomationTurnExpanded:
    vi.fn<typeof TypeImport_1gl5zx7.readAutomationTurnExpanded>(),
  streamAutomationTurn: vi.fn<typeof TypeImport_1gl5zx7.streamAutomationTurn>(),
}));

const item = (
  over: Partial<CentraidAutomationItem> = {}
): CentraidAutomationItem =>
  ({
    itemId: "i1",
    turnId: "c-1",
    ordinal: 0,
    kind: "tool",
    name: "write_file",
    ok: true,
    startedAt: 1000,
    endedAt: 1200,
    durationMs: 200,
    ...over,
  }) as CentraidAutomationItem;

describe(compileStepOf, () => {
  it("drops the compiler input item — the instructions are already on screen", () => {
    expect(
      compileStepOf(item({ kind: "message_in", name: undefined }))
    ).toBeNull();
  });

  it("surfaces the error as the detail on a failed step", () => {
    const step = compileStepOf(
      item({
        ok: false,
        error: "unexpected token",
        outputJson: '{"path":"handler.js"}',
      })
    );
    expect(step).toMatchObject({
      status: "fail",
      label: "write_file",
      detail: "unexpected token",
    });
  });

  it("marks an unfinished step running rather than failed", () => {
    const step = compileStepOf(
      item({ endedAt: undefined, durationMs: undefined })
    );
    expect(step?.status).toBe("running");
    expect(step?.durationMs).toBeNull();
  });

  it("prefers a readable field over the raw JSON envelope", () => {
    expect(
      compileStepOf(item({ outputJson: '{"path":"handler.js","bytes":9182}' }))
        ?.detail
    ).toBe("handler.js");
    // No readable field and no text ⇒ no detail, rather than a JSON blob.
    expect(
      compileStepOf(item({ outputJson: '{"bytes":9182}' }))?.detail
    ).toBeNull();
  });

  it("names a model step by its model instead of leaving it blank", () => {
    expect(
      compileStepOf(item({ kind: "step", name: undefined, model: "sonnet" }))
        ?.label
    ).toBe("Model · sonnet");
  });
});

describe(compileSteps, () => {
  it("orders by ordinal so a live stream reads in the order work happened", () => {
    const steps = compileSteps([
      item({ itemId: "b", ordinal: 2, name: "typecheck" }),
      item({ itemId: "a", ordinal: 1, name: "write_file" }),
      item({ itemId: "in", ordinal: 0, kind: "message_in", name: undefined }),
    ]);
    expect(steps.map((s) => s.label)).toStrictEqual([
      "write_file",
      "typecheck",
    ]);
  });
});

describe(compileAttemptOf, () => {
  it("reads an unfinished compile as running, not as a failure", () => {
    const attempt = compileAttemptOf({
      turnId: "c-1",
      startedAt: Date.now(),
      ok: false,
      pinned: false,
    } as unknown as CentraidAutomationTurnRecord);
    expect(attempt.status).toBe("running");
    expect(attempt.endedAt).toBeNull();
  });

  it("carries the failure text verbatim for the rail to render", () => {
    const attempt = compileAttemptOf({
      turnId: "c-1",
      startedAt: Date.now(),
      endedAt: Date.now(),
      ok: false,
      error: "handler.js: unexpected token",
      pinned: false,
    } as unknown as CentraidAutomationTurnRecord);
    expect(attempt).toMatchObject({
      status: "fail",
      error: "handler.js: unexpected token",
    });
  });
});

const turn = (
  over: Partial<CentraidAutomationTurnRecord> = {}
): CentraidAutomationTurnRecord =>
  ({
    turnId: "c-1",
    startedAt: 1000,
    endedAt: 2000,
    ok: true,
    triggerKind: "compile",
    pinned: false,
    ...over,
  }) as unknown as CentraidAutomationTurnRecord;

describe(loadCompileAttempts, () => {
  it("keeps only compile turns — a real run is not a compile attempt", async () => {
    vi.mocked(listAutomationTurns).mockResolvedValue([
      turn({ turnId: "c-1", startedAt: 1000 }),
      turn({ turnId: "r-1", startedAt: 2000, triggerKind: "scheduled" }),
    ] as never);
    const attempts = await loadCompileAttempts("digest/main");
    expect(attempts.map((a) => a.turnId)).toStrictEqual(["c-1"]);
  });

  it("orders newest first, so the rail opens on the attempt that matters", async () => {
    vi.mocked(listAutomationTurns).mockResolvedValue([
      turn({ turnId: "old", startedAt: 1000 }),
      turn({ turnId: "new", startedAt: 9000 }),
    ] as never);
    const attempts = await loadCompileAttempts("digest/main");
    expect(attempts.map((a) => a.turnId)).toStrictEqual(["new", "old"]);
  });
});

describe(loadTurnSteps, () => {
  it("reads one turn cold and projects its items to ordered steps", async () => {
    vi.mocked(readAutomationTurnExpanded).mockResolvedValue({
      turn: turn(),
      items: [
        item({ itemId: "b", ordinal: 1 }),
        item({ itemId: "a", ordinal: 0 }),
      ],
    } as never);
    const steps = await loadTurnSteps("c-1");
    expect(steps.map((s) => s.itemId)).toStrictEqual(["a", "b"]);
  });
});

describe(watchTurnSteps, () => {
  it("paints the ledger first, folds live events, then trusts the final read", async () => {
    // A turn that is already underway when the rail attaches: the cold read
    // seeds the list so the owner never sees an empty rail for a compile that
    // has been running for minutes.
    vi.mocked(readAutomationTurnExpanded)
      .mockResolvedValueOnce({
        turn: turn(),
        items: [item({ itemId: "a", ordinal: 0 })],
      } as never)
      .mockResolvedValueOnce({
        turn: turn({ endedAt: 5000, ok: true }),
        items: [
          item({ itemId: "a", ordinal: 0 }),
          item({ itemId: "b", ordinal: 1 }),
        ],
      } as never);
    vi.mocked(streamAutomationTurn).mockImplementation((async (
      _id: string,
      apply: (e: unknown) => void
    ) => {
      apply({
        type: "item.start",
        itemId: "b",
        ordinal: 1,
        kind: "tool",
        name: "typecheck",
      });
      apply({
        type: "item.end",
        itemId: "b",
        ordinal: 1,
        ok: true,
        durationMs: 120,
      });
      apply({ type: "turn.end", ok: true });
    }) as never);

    const seen: number[] = [];
    const outcome = await watchTurnSteps(
      "c-1",
      (s) => seen.push(s.length),
      new AbortController().signal
    );

    expect(seen[0]).toBe(1); // cold paint before any event
    expect(seen).toContain(2); // the streamed step landed
    expect(outcome).toStrictEqual({ settled: true, ok: true });
  });

  it("reports unsettled on abort rather than claiming the compile finished", async () => {
    const controller = new AbortController();
    vi.mocked(readAutomationTurnExpanded).mockResolvedValue({
      turn: null,
      items: [],
    } as never);
    vi.mocked(streamAutomationTurn).mockImplementation((async () => {
      controller.abort();
    }) as never);
    const outcome = await watchTurnSteps(
      "c-1",
      () => undefined,
      controller.signal
    );
    // An aborted watch must never be read as a settled turn — the rail would
    // stop following a compile that is still running.
    expect(outcome).toStrictEqual({ settled: false, ok: false });
  });

  it("survives a cold read that fails, so a stream can still drive the rail", async () => {
    vi.mocked(readAutomationTurnExpanded)
      .mockRejectedValueOnce(new Error("500"))
      .mockResolvedValueOnce({
        turn: turn({ endedAt: 5000, ok: false }),
        items: [],
      } as never);
    vi.mocked(streamAutomationTurn).mockImplementation(
      (async () => undefined) as never
    );
    const outcome = await watchTurnSteps(
      "c-1",
      () => undefined,
      new AbortController().signal
    );
    expect(outcome).toStrictEqual({ settled: true, ok: false });
  });
});
