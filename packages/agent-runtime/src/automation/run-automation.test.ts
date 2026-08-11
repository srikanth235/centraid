/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Direct unit test naming run-automation.ts (issue #545 B11).
 * Mocks the automation fire spine so we assert openDispatch wiring without a full fire.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  LiveDispatch,
  LiveDispatchOptions,
} from "./run-automation-live-dispatch.js";

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
      agentCalls: 0,
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
      agentCalls: 0,
    },
  };
}
const liveDispatch = vi.hoisted(() => ({
  start: vi.fn<(options: LiveDispatchOptions) => Promise<LiveDispatch>>(
    async () => ({
      agentDispatcher: async () => ({ text: "ok" }),
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
    parseAutomationAgentFailure: (error: string | undefined) => {
      const prefix = "centraid-agent-failure:";
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
    it("forwards fire options and injects openDispatch that captures runner kind", async () => {
      const result = await runAutomation({
        automationRef: "app/digest",
        appsDir: "/apps",
        journalDbFile: "/j.db",
        runner: "claude-code",
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
          runner: "claude-code",
          model: "from-manifest",
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
        expect.objectContaining({ model: "m1", runner: "claude-code" })
      );
    });

    it("defaults runner to codex when omitted", async () => {
      await runAutomation({
        automationRef: "app/a",
        appsDir: "/apps",
        journalDbFile: "/j.db",
      });
      const deps = runFire.mock.calls[0]![1];
      deps.openDispatch({
        workdir: "/w",
        automationRef: "app/a",
        runId: "r",
        onLog: () => undefined,
      });
      expect(startLiveDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ runner: "codex" })
      );
    });

    it("re-enters a failed automation on the next ladder rung as a new ledger turn", async () => {
      const failure =
        'centraid-agent-failure:{"runner":"codex","failureClass":"quota","message":"limit"}';
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
        runId: "run-fire",
        runner: "codex",
        runnerLadder: ["codex", "claude-code"],
        onFailover,
      });

      expect(result.outcome.ok).toBe(true);
      expect(runFire).toHaveBeenCalledTimes(2);
      expect(runFire.mock.calls.map((call) => call[0])).toStrictEqual([
        expect.objectContaining({ runId: "run-fire", runnerKind: "codex" }),
        expect.objectContaining({
          runId: "run-fire:failover:1:claude-code",
          runnerKind: "claude-code",
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

    it("does not replay a fire on another provider when an explicit call runner fails", async () => {
      const failure =
        'centraid-agent-failure:{"runner":"gemini","failureClass":"quota","message":"limit","explicitRunner":true}';
      runFire.mockResolvedValueOnce(
        fireResult({ ok: false, runId: "run-fire", error: failure })
      );
      const onFailover = vi.fn<AutomationFailover>();

      const result = await runAutomation({
        automationRef: "app/digest",
        appsDir: "/apps",
        journalDbFile: "/j.db",
        runId: "run-fire",
        runner: "codex",
        runnerLadder: ["claude-code"],
        onFailover,
      });

      expect(result.outcome.ok).toBe(false);
      expect(runFire).toHaveBeenCalledOnce();
      const deferOnFailure = runFire.mock.calls[0]![0].deferOnFailure;
      expect(deferOnFailure).toStrictEqual(expect.any(Function));
      if (typeof deferOnFailure !== "function") {
        throw new Error(
          "expected runAutomation to install a failure deferral predicate"
        );
      }
      expect(deferOnFailure(result.outcome)).toBe(false);
      expect(onFailover).not.toHaveBeenCalled();
    });

    it("keeps the caller trigger note alongside the failover notice", async () => {
      const failure =
        'centraid-agent-failure:{"runner":"codex","failureClass":"quota","message":"limit"}';
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
        runId: "run-fire",
        runner: "codex",
        runnerLadder: ["codex", "claude-code"],
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
        runId: "run-fire",
        runner: "codex",
        runnerLadder: ["codex", "claude-code"],
        runnerHealthContext: "vault-1",
        runnerHealth: {
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
        runnerKind: "claude-code",
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
          runner: "codex",
          runnerHealthContext: "vault-1",
          runnerHealth: {
            canAttempt: () => ({ allowed: false, failureClass: "auth" }),
            reportFailure: () => undefined,
            reportOk: () => undefined,
            reportPreflightOk: () => undefined,
            list: () => [],
          },
        })
      ).rejects.toThrow("no runner available");
      expect(runFire).not.toHaveBeenCalled();
    });

    it("does not treat a manifest-pinned primary as user enrollment", async () => {
      await runAutomation({
        automationRef: "app/digest",
        appsDir: "/apps",
        journalDbFile: "/j.db",
        runner: "gemini",
        runnerSelectionSource: "manifest",
        enrolledPrimaryRunner: "codex",
      });
      const deps = runFire.mock.calls[0]![1];
      deps.openDispatch({
        workdir: "/w",
        automationRef: "app/digest",
        runId: "r",
        onLog: () => undefined,
      });
      expect(startLiveDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ runner: "gemini" })
      );
      const liveOpts = startLiveDispatch.mock.calls[0]?.[0];
      expect(liveOpts?.consentSource).toBeUndefined();
      expect(liveOpts?.consentSourceFor?.("gemini")).toBeUndefined();
    });

    it("recognizes a manifest-pinned primary that is in the user's ladder", async () => {
      await runAutomation({
        automationRef: "app/digest",
        appsDir: "/apps",
        journalDbFile: "/j.db",
        runner: "gemini",
        runnerSelectionSource: "manifest",
        runnerLadder: ["codex", "gemini"],
        enrolledPrimaryRunner: "codex",
      });
      const deps = runFire.mock.calls[0]![1];
      deps.openDispatch({
        workdir: "/w",
        automationRef: "app/digest",
        runId: "r",
        onLog: () => undefined,
      });
      const liveOpts = startLiveDispatch.mock.calls[0]?.[0];
      expect(liveOpts?.consentSourceFor?.("gemini")).toBe("ladder");
    });

    it("marks the user's primary direct after a manifest-selected rung fails", async () => {
      const failure =
        'centraid-agent-failure:{"runner":"gemini","failureClass":"quota","message":"limit"}';
      runFire
        .mockResolvedValueOnce(
          fireResult({ ok: false, runId: "run-fire", error: failure })
        )
        .mockResolvedValueOnce(
          fireResult({
            ok: true,
            runId: "run-fire:failover:1:codex",
            value: "done",
          })
        );

      await runAutomation({
        automationRef: "app/digest",
        appsDir: "/apps",
        journalDbFile: "/j.db",
        runId: "run-fire",
        runner: "gemini",
        runnerSelectionSource: "manifest",
        runnerLadder: ["codex"],
        enrolledPrimaryRunner: "codex",
      });

      const fallbackDeps = runFire.mock.calls[1]![1];
      fallbackDeps.openDispatch({
        workdir: "/w",
        automationRef: "app/digest",
        runId: "run-fire:failover:1:codex",
        onLog: () => undefined,
      });
      expect(startLiveDispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({ runner: "codex", consentSource: "direct" })
      );
    });
  });
});
