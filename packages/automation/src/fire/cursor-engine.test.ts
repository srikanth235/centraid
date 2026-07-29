import path from "node:path";

import {
  AutomationTriggerStore,
  makeJournalDbProvider,
} from "@centraid/app-engine";
import { tempDirSync } from "@centraid/test-kit/temp-dir";
import { describe, expect, it, vi } from "vitest";

import type { Manifest } from "../manifest/manifest.js";
import type { Row } from "../scaffold/app.js";
import {
  VaultCursorEngine,
  assertTriggerCursorAllowed,
} from "./cursor-engine.js";
import type {
  TriggerCursorFireInput,
  VaultCursorEngineOptions,
} from "./cursor-engine.js";

function row(ref: string, triggers: Manifest["triggers"]): Row {
  const [ownerApp, id] = ref.split("/") as [string, string];
  const manifest: Manifest = {
    name: id,
    version: "0.1.0",
    enabled: true,
    prompt: "test",
    triggers,
    requires: {},
    history: { keep: "all" },
    generated: { by: "test", at: "2026-01-01T00:00:00.000Z" },
  };
  return {
    id,
    ownerApp,
    ref,
    name: id,
    dir: `/tmp/${id}`,
    enabled: true,
    triggers,
    manifest,
  };
}

function store(): AutomationTriggerStore {
  return new AutomationTriggerStore(
    makeJournalDbProvider(
      path.join(tempDirSync("centraid-cursor-engine-"), "journal.db")
    )
  );
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe(VaultCursorEngine, () => {
  it("collapses a cron restart gap to the latest instant with write-ahead intent", async () => {
    const cursors = store();
    cursors.putCursor({
      automationId: "clock/minutely",
      triggerIndex: 0,
      sourceKind: "cron",
      positionJson: JSON.stringify(Date.UTC(2026, 0, 1, 8, 0)),
      updatedAt: Date.UTC(2026, 0, 1, 8, 0),
    });
    const fired: TriggerCursorFireInput[] = [];
    const at = new Date(Date.UTC(2026, 0, 1, 8, 5));
    const engine = new VaultCursorEngine({
      store: cursors,
      now: () => at,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      fireCursor: (input) => {
        const during = cursors.getCursor(
          input.automationRef,
          input.triggerIndex
        );
        expect(during?.positionJson).toBe(
          JSON.stringify(Date.UTC(2026, 0, 1, 8, 0))
        );
        expect(during?.pendingJson).toContain(JSON.stringify(at.getTime()));
        fired.push(input);
      },
    });
    await engine.reconcile([
      row("clock/minutely", [{ kind: "cron", expr: "* * * * *" }]),
    ]);

    engine.tick();
    await settle();

    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      sourceKind: "cron",
      skipped: 4,
      gapReason: "scheduler_gap",
      element: { occurredAt: at.getTime() },
    });
    expect(cursors.getCursor("clock/minutely", 0)).toMatchObject({
      positionJson: JSON.stringify(at.getTime()),
    });
    expect(cursors.getCursor("clock/minutely", 0)?.pendingJson).toBeUndefined();
  });

  it("fires the latest missed cron instant on the first tick after a sleep", async () => {
    const cursors = store();
    const from = new Date(2026, 0, 1, 8, 0).getTime();
    cursors.putCursor({
      automationId: "clock/daily",
      triggerIndex: 0,
      sourceKind: "cron",
      positionJson: JSON.stringify(from),
      updatedAt: from,
    });
    const fired: TriggerCursorFireInput[] = [];
    const at = new Date(2026, 0, 1, 10, 0);
    const engine = new VaultCursorEngine({
      store: cursors,
      now: () => at,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      fireCursor: (input) => void fired.push(input),
    });

    await engine.reconcile([
      row("clock/daily", [{ kind: "cron", expr: "0 9 * * *" }]),
    ]);
    // Registration itself must never fire — the catch-up belongs to the tick.
    expect(fired).toStrictEqual([]);

    engine.tick();
    await settle();

    expect(fired).toStrictEqual([
      expect.objectContaining({
        element: expect.objectContaining({
          occurredAt: new Date(2026, 0, 1, 9, 0).getTime(),
        }),
      }),
    ]);
    expect(cursors.getCursor("clock/daily", 0)?.positionJson).toBe(
      JSON.stringify(at.getTime())
    );
  });

  it("caps every source uniformly and records the skipped gap once", async () => {
    const cursors = store();
    const fired: TriggerCursorFireInput[] = [];
    const engine = new VaultCursorEngine({
      store: cursors,
      catchUpCap: 2,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor: async () => ({
        elements: [
          { position: "1", occurredAt: 1 },
          { position: "2", occurredAt: 2 },
        ],
        positionJson: '"watermark-5"',
        skipped: 3,
        gapReason: "provider_catch_up_cap",
      }),
      fireCursor: (input) => void fired.push(input),
      now: () => new Date(Date.UTC(2026, 0, 1, 8, 0)),
    });
    await engine.reconcile([
      row("mail/watch", [
        { kind: "data", entities: ["core.party"], every: "* * * * *" },
      ]),
    ]);

    expect(fired.map((entry) => entry.element.position)).toStrictEqual([
      "1",
      "2",
    ]);
    expect(fired.every((entry) => entry.skipped === 3)).toBe(true);
    expect(cursors.getCursor("mail/watch", 0)).toMatchObject({
      positionJson: '"watermark-5"',
      skipped: 3,
      gapReason: "provider_catch_up_cap",
    });
  });

  it("keeps the declared one-minute data and five-minute condition defaults", async () => {
    const readRefs: string[] = [];
    const at = new Date(Date.UTC(2026, 0, 1, 8, 1));
    const engine = new VaultCursorEngine({
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      now: () => at,
      readCursor: async ({ automationRef }) => {
        readRefs.push(automationRef);
        return { elements: [], positionJson: JSON.stringify(at.getTime()) };
      },
    });
    await engine.reconcile([
      row("watch/data", [{ kind: "data", entities: ["core.party"] }]),
      row("watch/condition", [{ kind: "condition", entity: "schedule.task" }]),
    ]);
    readRefs.length = 0;

    engine.tick();
    await settle();

    expect(readRefs).toStrictEqual(["watch/data"]);
  });

  it("drains durable webhook ingress on restart bootstrap", async () => {
    const cursors = store();
    const fired: string[] = [];
    const trigger = {
      kind: "webhook" as const,
      id: "hook-id",
      secretHash: "a".repeat(64),
    };
    const engine = new VaultCursorEngine({
      store: cursors,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor: async ({ cursor }) => ({
        elements: cursor
          ? []
          : [{ position: "9", occurredAt: 9, payload: { hello: true } }],
        positionJson: "9",
      }),
      fireCursor: (input) => void fired.push(input.element.position),
    });

    await engine.reconcile([row("hooks/receive", [trigger])]);

    expect(fired).toStrictEqual(["9"]);
    expect(cursors.getCursor("hooks/receive", 0)?.positionJson).toBe("9");
  });

  it("reads past a committed data cursor during restart bootstrap", async () => {
    const cursors = store();
    let latest = 0;
    const readCursor = async ({
      cursor,
    }: {
      cursor?: { positionJson?: string };
    }): Promise<{
      elements: Array<{ position: string; occurredAt: number }>;
      positionJson: string;
    }> => {
      const position = Number(cursor?.positionJson ?? 0);
      return {
        elements:
          latest > position
            ? [{ position: String(latest), occurredAt: latest }]
            : [],
        positionJson: String(latest),
      };
    };
    const trigger = { kind: "data" as const, entities: ["core.party"] };
    const first = new VaultCursorEngine({
      store: cursors,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor,
      fireCursor: vi.fn<NonNullable<VaultCursorEngineOptions["fireCursor"]>>(),
    });
    await first.reconcile([row("watch/restart", [trigger])]);
    expect(cursors.getCursor("watch/restart", 0)?.positionJson).toBe("0");

    latest = 1;
    const fired: string[] = [];
    const restarted = new VaultCursorEngine({
      store: cursors,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor,
      fireCursor: ({ element }) => void fired.push(element.position),
    });
    await restarted.reconcile([row("watch/restart", [trigger])]);

    expect(fired).toStrictEqual(["1"]);
    expect(cursors.getCursor("watch/restart", 0)?.positionJson).toBe("1");
  });

  it("retries only the unacknowledged ingress after a mid-batch fire interruption", async () => {
    const cursors = store();
    const elements = [
      { position: "9", occurredAt: 9 },
      { position: "10", occurredAt: 10 },
    ];
    const attempted: string[] = [];
    const first = new VaultCursorEngine({
      store: cursors,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor: async () => ({ elements, positionJson: "10" }),
      fireCursor: ({ element }) => {
        attempted.push(element.position);
        if (element.position === "10") throw new Error("gateway stopped");
      },
    });
    const trigger = {
      kind: "webhook" as const,
      id: "hook-id",
      secretHash: "a".repeat(64),
    };

    await expect(
      first.reconcile([row("hooks/restart", [trigger])])
    ).rejects.toThrow("gateway stopped");
    expect(cursors.getCursor("hooks/restart", 0)).toMatchObject({
      pendingJson: expect.stringContaining('"9"'),
    });
    expect(cursors.getCursor("hooks/restart", 0)?.positionJson).toBeUndefined();

    const second = new VaultCursorEngine({
      store: cursors,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor: async ({ cursor }) => ({
        elements:
          cursor?.positionJson === "10"
            ? [{ position: "11", occurredAt: 11 }]
            : [...elements, { position: "11", occurredAt: 11 }],
        positionJson: "11",
      }),
      fireCursor: ({ element }) => void attempted.push(element.position),
    });
    await second.reconcile([row("hooks/restart", [trigger])]);

    expect(attempted).toStrictEqual(["9", "10", "10"]);
    expect(cursors.getCursor("hooks/restart", 0)).toMatchObject({
      positionJson: "10",
    });
    expect(cursors.getCursor("hooks/restart", 0)?.pendingJson).toBeUndefined();

    second.nudgeIngress("hook-id");
    await settle();
    expect(attempted).toStrictEqual(["9", "10", "10", "11"]);
    expect(cursors.getCursor("hooks/restart", 0)?.positionJson).toBe("11");
  });

  it("drains a webhook delivery that arrives after the initial cursor bootstrap", async () => {
    const cursors = store();
    const pending: Array<{ position: string; occurredAt: number }> = [];
    const fired: string[] = [];
    const trigger = {
      kind: "webhook" as const,
      id: "hook-id",
      secretHash: "a".repeat(64),
    };
    const engine = new VaultCursorEngine({
      store: cursors,
      nudgeDelayMs: 0,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor: async () => ({
        elements: pending.splice(0),
        positionJson: pending.length ? pending.at(-1)?.position : "0",
      }),
      fireCursor: (input) => void fired.push(input.element.position),
    });
    await engine.reconcile([row("hooks/receive", [trigger])]);
    pending.push({ position: "10", occurredAt: 10 });

    engine.nudgeIngress("hook-id");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    expect(fired).toStrictEqual(["10"]);
  });

  it("keeps an event trigger registered when its provider is unavailable at bootstrap", async () => {
    const onError = vi.fn<NonNullable<VaultCursorEngineOptions["onError"]>>();
    const engine = new VaultCursorEngine({
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor: async () => {
        throw new Error("account needs auth");
      },
      onError,
    });

    await expect(
      engine.reconcile([
        row("mail/watch", [
          {
            kind: "event",
            connectorKind: "pull.gmail",
            event: "new-message",
          },
        ]),
      ])
    ).resolves.toMatchObject({ added: ["mail/watch"] });

    await expect(engine.list()).resolves.toStrictEqual(["mail/watch"]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "mail/watch");
  });

  it("rejects loop-sensitive runtime entities at registration", async () => {
    const denied = {
      kind: "condition" as const,
      entity: "trigger_ingress",
    };
    expect(() => assertTriggerCursorAllowed(denied)).toThrow(
      /loop-sensitive runtime table/u
    );
    const engine = new VaultCursorEngine({
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
    });
    await expect(engine.reconcile([row("bad/loop", [denied])])).rejects.toThrow(
      /loop-sensitive runtime table/u
    );
  });
});
