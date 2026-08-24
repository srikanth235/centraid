import { describe, expect, it, vi } from "vitest";

import {
  handleRunsMessage,
  handleStateMessage,
  nextOrdinal,
  resolveContentAttachments,
} from "./ctx.js";
import type { AuditState } from "./ctx.js";

function audit(over: Partial<AuditState> = {}): AuditState {
  return {
    store: {
      stateGet: vi.fn<AuditState["store"]["stateGet"]>(),
      stateSet: vi.fn<AuditState["store"]["stateSet"]>(),
      stateDelete: vi.fn<AuditState["store"]["stateDelete"]>(),
      listAutomationTurns: vi.fn<AuditState["store"]["listAutomationTurns"]>(
        () => []
      ),
      messageInText: vi.fn<AuditState["store"]["messageInText"]>(
        () => undefined
      ),
    } as never,
    runId: "current-run",
    automationId: "app/digest",
    ordinal: 0,
    emit: () => undefined,
    ...over,
  };
}

describe(nextOrdinal, () => {
  it("increments the audit ordinal and returns the previous value", () => {
    const a = audit({ ordinal: 3 });
    expect(nextOrdinal(a)).toBe(3);
    expect(nextOrdinal(a)).toBe(4);
    expect(a.ordinal).toBe(5);
  });
});

describe(resolveContentAttachments, () => {
  it("needs no vault surface when the call has no content refs", async () => {
    await expect(
      resolveContentAttachments(undefined, [])
    ).resolves.toStrictEqual([]);
  });

  it("still fails closed for a content-bearing call without a vault surface", async () => {
    await expect(
      resolveContentAttachments(undefined, [
        { contentId: "content-1", variant: "preview" },
      ])
    ).rejects.toThrow("need a vault surface");
  });
});

describe(handleStateMessage, () => {
  it("get/set/delete against the automation state map", () => {
    const store = {
      stateGet: vi.fn<AuditState["store"]["stateGet"]>((automationId, key) =>
        key === "cursor" && automationId === "app/digest"
          ? { automationId, key, valueJson: '{"n":1}', updatedAt: 1 }
          : undefined
      ),
      stateSet: vi.fn<AuditState["store"]["stateSet"]>(),
      stateDelete: vi.fn<AuditState["store"]["stateDelete"]>(),
    };
    const a = audit({ store: store as never });

    expect(handleStateMessage(a, "get", "missing", undefined)).toStrictEqual({
      ok: true,
      result: undefined,
    });
    expect(handleStateMessage(a, "get", "cursor", undefined)).toStrictEqual({
      ok: true,
      result: { n: 1 },
    });

    // Non-JSON valueJson is returned as the raw string.
    store.stateGet.mockReturnValueOnce({
      automationId: "app/digest",
      key: "raw",
      valueJson: "not-json",
      updatedAt: 1,
    });
    expect(handleStateMessage(a, "get", "raw", undefined).result).toBe(
      "not-json"
    );

    expect(handleStateMessage(a, "set", "cursor", { n: 2 })).toStrictEqual({
      ok: true,
    });
    expect(store.stateSet).toHaveBeenCalledWith(
      "app/digest",
      "cursor",
      JSON.stringify({ n: 2 }),
      expect.any(Number)
    );

    expect(handleStateMessage(a, "delete", "cursor", undefined)).toStrictEqual({
      ok: true,
    });
    expect(store.stateDelete).toHaveBeenCalledWith("app/digest", "cursor");

    expect(
      handleStateMessage(a, "nope" as "get", "k", undefined)
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unknown state method/u),
    });
  });

  it("surfaces store exceptions as ok:false", () => {
    const a = audit({
      store: {
        stateGet: () => {
          throw new Error("db down");
        },
      } as never,
    });
    expect(handleStateMessage(a, "get", "k", undefined)).toStrictEqual({
      ok: false,
      error: "db down",
    });
  });
});

describe(handleRunsMessage, () => {
  it("lists / last-s the automation turns excluding the in-progress self-turn", () => {
    const turns = [
      {
        turnId: "current-run",
        conversationId: "app/digest",
        seq: 2,
        triggerKind: "scheduled" as const,
        startedAt: 30,
        ok: false,
        pinned: false,
      },
      {
        turnId: "t1",
        conversationId: "app/digest",
        seq: 1,
        triggerKind: "scheduled" as const,
        startedAt: 20,
        ok: true,
        pinned: false,
        summary: "ok",
      },
      {
        turnId: "t0",
        conversationId: "app/digest",
        seq: 0,
        triggerKind: "scheduled" as const,
        startedAt: 10,
        ok: false,
        pinned: false,
      },
    ];
    const store = {
      listAutomationTurns: vi.fn<AuditState["store"]["listAutomationTurns"]>(
        () => turns
      ),
      messageInText: vi.fn<AuditState["store"]["messageInText"]>((id) =>
        id === "t1" ? '{"x":1}' : undefined
      ),
    };
    const a = audit({ store: store as never });

    const list = handleRunsMessage(a, "list", { limit: 10 });
    expect(list.ok).toBe(true);
    expect(
      (list.result as { runId: string }[]).map((r) => r.runId)
    ).toStrictEqual(["t1", "t0"]);
    expect((list.result as { input?: unknown }[])[0]?.input).toStrictEqual({
      x: 1,
    });

    const last = handleRunsMessage(a, "last", {});
    expect(last.ok).toBe(true);
    expect((last.result as { runId: string }).runId).toBe("t1");

    // Empty history → last is undefined.
    store.listAutomationTurns.mockReturnValueOnce([]);
    expect(handleRunsMessage(a, "last", {}).result).toBeUndefined();
  });
});
