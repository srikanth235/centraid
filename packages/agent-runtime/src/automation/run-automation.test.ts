/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Direct unit test naming run-automation.ts (issue #545 B11).
 * Mocks the automation fire spine so we assert openDispatch wiring without a full fire.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunTurnFn } from "@centraid/app-engine";

import type {
  LiveDispatch,
  LiveDispatchOptions,
} from "./run-automation-live-dispatch.js";

/** Stand-in for the host's accounted turn driver (#743). */
const stubRunTurn: RunTurnFn = async () => ({ harnessKind: "codex" });

const { runFire } = vi.hoisted(() => ({
  runFire: vi.fn<typeof TypeImport_2es3ft.runFire>(),
}));
type AutomationFailover = NonNullable<
  Parameters<typeof TypeImport_1plgb7w.runAutomation>[0]["onFailover"]
>;
type FireResult = Awaited<ReturnType<typeof runFire>>;

function fireResult(input: {
  ok: boolean;
  runId: string;
  value?: unknown;
  error?: string;
}): FireResult {
  return {
    outcome: {
      ok: input.ok,
      ...(input.value === undefined ? {} : { value: input.value }),
      ...(input.error === undefined ? {} : { error: input.error }),
      logs: [],
      toolBatches: 0,
      delegateCalls: 0,
    },
    record: {
      automationRef: "app/a",
      automationName: "Automation",
      runId: input.runId,
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
      ok: input.ok,
      ...(input.error === undefined ? {} : { error: input.error }),
      toolBatches: 0,
      delegateCalls: 0,
    },
  };
}
const liveDispatch = vi.hoisted(() => ({
  start: vi.fn<(options: LiveDispatchOptions) => Promise<LiveDispatch>>(
    async () => ({
      delegateDispatcher: async () => ({ text: "ok" }),
      finalizeTurn: () => undefined,
      close: async () => undefined,
    })
  ),
}));
const startLiveDispatch = liveDispatch.start;

vi.mock(import("@centraid/automation"), () => ({
  runFire,
}));

vi.mock(
  import("./run-automation-live-dispatch.js"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    startLiveDispatch: liveDispatch.start,
    parseAutomationDelegateFailure: (error: string | undefined) => {
      const prefix = "centraid-delegate-failure:";
      if (!error?.startsWith(prefix)) return undefined;
      return JSON.parse(error.slice(prefix.length));
    },
  })
);

import type * as TypeImport_2es3ft from "@centraid/automation";

import { runAutomation } from "./run-automation.ts";
import type * as TypeImport_1plgb7w from "./run-automation.ts";

describe("run-automation suite", () => {
  beforeEach(() => {
    runFire.mockReset();
    startLiveDispatch.mockClear();
    runFire.mockResolvedValue(
      fireResult({ ok: true, runId: "r1", value: { summary: "done" } })
    );
  });

  describe(runAutomation, () => {
    it("forwards fire options and injects openDispatch that captures harness kind", async () => {
      const result = await runAutomation({
        automationRef: "app/digest",
        appsDir: "/apps",
        journalDbFile: "/j.db",
        runTurn: stubRunTurn,
        harness: "claude-code",
        model: "m1",
        runId: "run-1",
        triggerKind: "scheduled",
        input: { x: 1 },
      });

      expect(result.outcome.ok).toBe(true);
      expect(runFire).toHaveBeenCalledOnce();
      const [fireOpts, deps] = runFire.mock.calls[0]!;
      expect(fireOpts).toMatchObject({
        automationRef: "app/digest",
        appsDir: "/apps",
        journalDbFile: "/j.db",
        runId: "run-1",
        triggerKind: "scheduled",
        input: { x: 1 },
      });

      deps.openDispatch({
        workdir: "/w",
        automationRef: "app/digest",
        runId: "run-1",
        model: "from-manifest",
        onLog: () => undefined,
      });
      expect(startLiveDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          workdir: "/w",
          runId: "run-1",
          harness: "claude-code",
          model: "from-manifest",
          // The accounted seam rides every rung — a fire never resolves its
          // own harness (#743).
          runTurn: stubRunTurn,
        })
      );

      // Fallback to opts.model when manifest does not name one.
      deps.openDispatch({
        workdir: "/w",
        automationRef: "app/digest",
        runId: "run-1",
        onLog: () => undefined,
      });
      expect(startLiveDispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({ model: "m1", harness: "claude-code" })
      );
    });

    it("defaults harness to codex when omitted", async () => {
      await runAutomation({
        automationRef: "app/a",
        appsDir: "/apps",
        journalDbFile: "/j.db",
        runTurn: stubRunTurn,
      });
      const deps = runFire.mock.calls[0]![1];
      deps.openDispatch({
        workdir: "/w",
        automationRef: "app/a",
        runId: "r",
        onLog: () => undefined,
      });
      expect(startLiveDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ harness: "codex" })
      );
    });

    it("re-enters a failed automation on the next ladder rung as a new ledger turn", async () => {
      const failure =
        'centraid-delegate-failure:{"harness":"codex","failureClass":"quota","message":"limit"}';
      runFire
        .mockResolvedValueOnce(
          fireResult({ ok: false, runId: "run-fire", error: failure })
        )
        .mockResolvedValueOnce(
          fireResult({
            ok: true,
            runId: "run-fire:failover:1:claude-code",
            value: "done",
          })
        );
      const onFailover = vi.fn<AutomationFailover>();

      const result = await runAutomation({
        automationRef: "app/digest",
        appsDir: "/apps",
        journalDbFile: "/j.db",
        runTurn: stubRunTurn,
        runId: "run-fire",
        harness: "codex",
        harnessLadder: ["codex", "claude-code"],
        onFailover,
      });

      expect(result.outcome.ok).toBe(true);
      expect(runFire).toHaveBeenCalledTimes(2);
      expect(runFire.mock.calls.map((call) => call[0])).toStrictEqual([
        expect.objectContaining({ runId: "run-fire", harnessKind: "codex" }),
        expect.objectContaining({
          runId: "run-fire:failover:1:claude-code",
          harnessKind: "claude-code",
          note:
            "codex failed at the automation fire boundary (quota). " +
            "Continuing with claude-code; provider-specific model and effort pins were cleared.",
          failoverNotice:
            "codex failed at the automation fire boundary (quota). " +
            "Continuing with claude-code; provider-specific model and effort pins were cleared.",
        }),
      ]);
      expect(onFailover).toHaveBeenCalledWith(
        expect.objectContaining({ from: "codex", to: "claude-code" })
      );
    });

    it("keeps the caller trigger note alongside the failover notice", async () => {
      const failure =
        'centraid-delegate-failure:{"harness":"codex","failureClass":"quota","message":"limit"}';
      runFire
        .mockResolvedValueOnce(
          fireResult({ ok: false, runId: "run-fire", error: failure })
        )
        .mockResolvedValueOnce(
          fireResult({
            ok: true,
            runId: "run-fire:failover:1:claude-code",
            value: "done",
          })
        );

      await runAutomation({
        automationRef: "app/digest",
        appsDir: "/apps",
        journalDbFile: "/j.db",
        runTurn: stubRunTurn,
        runId: "run-fire",
        harness: "codex",
        harnessLadder: ["codex", "claude-code"],
        note: "Catching up 3 missed cron ticks.",
      });

      const secondNote = String(
        (runFire.mock.calls[1]![0] as { note?: unknown }).note ?? ""
      );
      expect(secondNote).toContain("Catching up 3 missed cron ticks.");
      expect(secondNote).toContain(
        "codex failed at the automation fire boundary (quota)"
      );
    });

    it("never runs the handler of a rung whose breaker is already open", async () => {
      runFire.mockResolvedValue(
        fireResult({
          ok: true,
          runId: "run-fire:failover:1:claude-code",
          value: "done",
        })
      );
      const onFailover = vi.fn<AutomationFailover>();

      await runAutomation({
        automationRef: "app/digest",
        appsDir: "/apps",
        journalDbFile: "/j.db",
        runTurn: stubRunTurn,
        runId: "run-fire",
        harness: "codex",
        harnessLadder: ["codex", "claude-code"],
        harnessHealthContext: "vault-1",
        harnessHealth: {
          canAttempt: (_context, kind) =>
            kind === "codex"
              ? { allowed: false, failureClass: "quota", breakerUntil: 5_000 }
              : { allowed: true },
          reportFailure: () => undefined,
          reportOk: () => undefined,
          reportPreflightOk: () => undefined,
          list: () => [],
        },
        onFailover,
      });

      // Exactly one fire: the condemned primary's handler never executed, so its
      // ctx.fetch / vault writes cannot be replayed by the fallback rung.
      expect(runFire).toHaveBeenCalledOnce();
      expect(runFire.mock.calls[0]![0]).toMatchObject({
        runId: "run-fire:failover:1:claude-code",
        harnessKind: "claude-code",
      });
      expect(onFailover).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "codex",
          to: "claude-code",
          failureClass: "quota",
        })
      );
    });

    it("refuses the fire when every rung is circuit-broken instead of running a handler", async () => {
      await expect(
        runAutomation({
          automationRef: "app/digest",
          appsDir: "/apps",
          journalDbFile: "/j.db",
          runTurn: stubRunTurn,
          harness: "codex",
          harnessHealthContext: "vault-1",
          harnessHealth: {
            canAttempt: () => ({ allowed: false, failureClass: "auth" }),
            reportFailure: () => undefined,
            reportOk: () => undefined,
            reportPreflightOk: () => undefined,
            list: () => [],
          },
        })
      ).rejects.toThrow("no harness available");
      expect(runFire).not.toHaveBeenCalled();
    });

    it("marks a manifest-pinned harness as ladder-derived consent, not a direct grant", async () => {
      await runAutomation({
        automationRef: "app/digest",
        appsDir: "/apps",
        journalDbFile: "/j.db",
        runTurn: stubRunTurn,
        harness: "gemini",
        harnessSelectionSource: "manifest",
      });
      const deps = runFire.mock.calls[0]![1];
      deps.openDispatch({
        workdir: "/w",
        automationRef: "app/digest",
        runId: "r",
        onLog: () => undefined,
      });
      expect(startLiveDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ harness: "gemini", consentSource: "ladder" })
      );
    });
  });
});
