/*
 * Opt-in live smoke for issue #567 acceptance. It exercises the two
 * requested registry kinds through the same `runTurn` entry point as product
 * surfaces. CI does not run it because it requires locally-authenticated CLIs
 * and incurs one tiny provider turn per harness.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TurnInput, TurnStreamEvent } from "@centraid/server/engine";

import { probeAcpCapabilities } from "../src/acp/backends/acp/probe-capabilities.js";
import { clearWarmPool } from "../src/acp/backends/acp/session-warm.js";
import { acpConfigFor, HARNESSES } from "../src/acp/registry.js";
import { runTurn } from "../src/acp/runtime.js";
import type { HarnessKind } from "../src/acp/types.js";

const isHarnessKind = (kind: string): kind is HarnessKind =>
  Object.hasOwn(HARNESSES, kind);

const requested = (process.env.CENTRAID_LIVE_ADAPTERS ?? "codex,claude-code")
  .split(",")
  .map((kind) => kind.trim())
  .filter(isHarnessKind);

const binFor = (kind: HarnessKind): string | undefined =>
  kind === "codex"
    ? process.env.CENTRAID_CODEX_BIN
    : kind === "claude-code"
      ? process.env.CENTRAID_CLAUDE_BIN
      : kind === "gemini"
        ? process.env.CENTRAID_GEMINI_BIN
        : kind === "opencode"
          ? process.env.CENTRAID_OPENCODE_BIN
          : undefined;

interface LiveAttempt {
  result: Awaited<ReturnType<typeof runTurn>>;
  events: TurnStreamEvent[];
  error?: Extract<TurnStreamEvent, { type: "error" }>;
  final?: Extract<TurnStreamEvent, { type: "final" }>;
}

async function runLive(
  kind: HarnessKind,
  cwd: string,
  message: string,
  input: Partial<
    Pick<
      TurnInput,
      | "configPins"
      | "prevSessionId"
      | "prevUsageSnapshot"
      | "hydrationContext"
      | "recoveryHydrationContext"
      | "forceHydration"
    >
  > = {}
): Promise<LiveAttempt> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  timeout.unref?.();
  const events: TurnStreamEvent[] = [];
  try {
    const result = await runTurn(
      {
        cwd,
        message,
        extraSystemPrompt:
          "This is a read-only transport smoke test. Do not inspect or change files.",
        permissionPolicy: "deny",
        abortSignal: controller.signal,
        onEvent: (event) => events.push(event),
        ...input,
      },
      {
        prefs: {
          kind,
          ...(binFor(kind) ? { binPath: binFor(kind) } : {}),
        },
      }
    );
    return {
      result,
      events,
      error: events.find(
        (event): event is Extract<TurnStreamEvent, { type: "error" }> =>
          event.type === "error"
      ),
      final: events.findLast(
        (event): event is Extract<TurnStreamEvent, { type: "final" }> =>
          event.type === "final"
      ),
    };
  } finally {
    clearTimeout(timeout);
  }
}

let failed = false;
const runNextAdapter = async (index: number): Promise<void> => {
  const kind = requested[index];
  if (kind === undefined) return;
  const cwd = await mkdtemp(path.join(tmpdir(), `centraid-live-${kind}-`));
  try {
    const caps = await probeAcpCapabilities(
      acpConfigFor(kind, binFor(kind) ? { binPath: binFor(kind) } : {}),
      { timeoutMs: 30_000 }
    );
    const thought = caps.configOptions.find(
      (option) => option.category === "thought_level"
    );
    const requestedEffort = thought?.currentValue ?? thought?.values[0]?.value;
    const attempt = await runLive(
      kind,
      cwd,
      "Reply with exactly LIVE_OK. Do not use tools.",
      requestedEffort ? { configPins: { thought_level: requestedEffort } } : {}
    );
    const usage = attempt.events.findLast(
      (event): event is Extract<TurnStreamEvent, { type: "usage" }> =>
        event.type === "usage"
    );
    const effortRoundTrip =
      !requestedEffort || usage?.effort === requestedEffort;
    const markerObserved = attempt.final?.text.includes("LIVE_OK") === true;
    const ok =
      !attempt.error &&
      Boolean(attempt.final?.text.trim()) &&
      attempt.result.harnessKind === kind &&
      effortRoundTrip;
    process.stdout.write(
      `${JSON.stringify({
        check: "adapter",
        kind,
        ok,
        markerObserved,
        session: Boolean(attempt.result.sessionId),
        capabilityProbe: {
          reachable: caps.reachable,
          usageUpdateObserved: caps.usageUpdateObserved,
          configOptionUpdateObserved: caps.configOptionUpdateObserved,
          locationsObserved: caps.locationsObserved,
        },
        ...(requestedEffort
          ? {
              effortRequested: requestedEffort,
              effortConfirmed: usage?.effort ?? null,
            }
          : {}),
        eventTypes: attempt.events.map((event) => event.type),
        ...(attempt.error ? { error: attempt.error.message } : {}),
      })}\n`
    );
    if (!ok) failed = true;
  } catch (error) {
    failed = true;
    process.stdout.write(
      `${JSON.stringify({
        check: "adapter",
        kind,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  return runNextAdapter(index + 1);
};
await runNextAdapter(0);

if (requested.length >= 2) {
  const [first, second] = requested as [
    HarnessKind,
    HarnessKind,
    ...HarnessKind[],
  ];
  const cwd = await mkdtemp(path.join(tmpdir(), "centraid-live-switch-"));
  try {
    const a = await runLive(
      first,
      cwd,
      "Reply with exactly SWITCH_A_TOKEN_567. Do not use tools."
    );
    const b = await runLive(
      second,
      cwd,
      "Reply with exactly SWITCH_B_SEES_A_567. Do not use tools.",
      {
        hydrationContext:
          "Centraid handoff from another harness. Prior user requested the exact marker " +
          "SWITCH_A_TOKEN_567 and the prior assistant answered SWITCH_A_TOKEN_567.",
        recoveryHydrationContext:
          "Full Centraid ledger. User: reply SWITCH_A_TOKEN_567. " +
          "Assistant: SWITCH_A_TOKEN_567.",
        forceHydration: true,
      }
    );
    const aReturn = await runLive(
      first,
      cwd,
      "Reply with exactly SWITCH_A_RETURN_567. Do not use tools.",
      {
        ...(a.result.sessionId ? { prevSessionId: a.result.sessionId } : {}),
        ...(a.result.usageSnapshot
          ? { prevUsageSnapshot: a.result.usageSnapshot }
          : {}),
        hydrationContext:
          "Centraid delta since this harness last ran. The other harness answered " +
          "SWITCH_B_SEES_A_567.",
        recoveryHydrationContext:
          "Full Centraid ledger. Assistant A: SWITCH_A_TOKEN_567. " +
          "Assistant B: SWITCH_B_SEES_A_567.",
        forceHydration: true,
      }
    );
    const markersObserved = {
      first: a.final?.text.includes("SWITCH_A_TOKEN_567") === true,
      second: b.final?.text.includes("SWITCH_B_SEES_A_567") === true,
      returned: aReturn.final?.text.includes("SWITCH_A_RETURN_567") === true,
    };
    const ok =
      !a.error &&
      Boolean(a.final?.text.trim()) &&
      !b.error &&
      Boolean(b.final?.text.trim()) &&
      !aReturn.error &&
      Boolean(aReturn.final?.text.trim()) &&
      b.events.some(
        (event) => event.type === "notice" && event.code === "session_hydrated"
      ) &&
      aReturn.events.some(
        (event) => event.type === "notice" && event.code === "session_hydrated"
      );
    process.stdout.write(
      `${JSON.stringify({
        check: "switch",
        route: `${first}->${second}->${first}`,
        ok,
        firstSession: Boolean(a.result.sessionId),
        secondSession: Boolean(b.result.sessionId),
        returnedSession: Boolean(aReturn.result.sessionId),
        secondHydrated: b.result.hydrated === true,
        returnHydrated: aReturn.result.hydrated === true,
        markersObserved,
        eventTypes: {
          first: a.events.map((event) => event.type),
          second: b.events.map((event) => event.type),
          returned: aReturn.events.map((event) => event.type),
        },
        ...(a.error || b.error || aReturn.error
          ? {
              error:
                a.error?.message ??
                b.error?.message ??
                aReturn.error?.message ??
                "switch failed",
            }
          : {}),
      })}\n`
    );
    if (!ok) failed = true;
  } catch (error) {
    failed = true;
    process.stdout.write(
      `${JSON.stringify({
        check: "switch",
        route: `${first}->${second}->${first}`,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
} else {
  failed = true;
}

await clearWarmPool();
if (failed) process.exitCode = 1;
