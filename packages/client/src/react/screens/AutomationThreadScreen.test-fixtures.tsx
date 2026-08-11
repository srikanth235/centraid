// Shared fixtures for the AutomationThreadScreen tests: the thread DTO (three
// runs across two date groups, one still running, plus consent cards), the
// bridge-props stub, and the mount/unmount harness. Test-only module —
// imported by AutomationThreadScreen.test.tsx /
// AutomationThreadScreenTurnWatch.test.tsx, never shipped.

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, vi } from "vitest";

import type { AutomationThreadBridgeProps } from "../screen-contracts.js";
import AutomationThreadScreen from "./AutomationThreadScreen.js";
import type { AutomationThreadDataEx } from "./AutomationThreadScreen.js";

export const NOW = new Date("2026-07-12T18:00:00Z").getTime();
export const YESTERDAY = NOW - 24 * 60 * 60 * 1000;

export function makeData(
  over: Partial<AutomationThreadDataEx> = {}
): AutomationThreadDataEx {
  return {
    automationTurns: true,
    consent: {
      grants: [
        {
          createdAt: new Date(YESTERDAY).toISOString(),
          grantId: "g1",
          revokedAt: null,
          target: "gmail:*",
          verb: "send",
        },
      ],
      outbox: [
        {
          artifact: { to: "x@y.com" },
          canEdit: true,
          connectionKind: "gmail",
          connectionLabel: "Gmail",
          itemId: "o1",
          note: null,
          stagedAt: new Date(NOW).toISOString(),
          status: "pending",
          target: "x@y.com",
          verb: "send",
        },
      ],
      parked: [
        {
          command: "locker.set_secret",
          input: {},
          invocationId: "p1",
          parkedAt: new Date(NOW).toISOString(),
        },
      ],
    },
    header: {
      description: "Summarize the inbox",
      entityTags: [],
      enabled: true,
      glyphIcon: "Bolt",
      heroIcon: "Clock",
      hue: "indigo",
      id: "a",
      kindEyebrow: "Cron schedule",
      name: "Daily Digest",
      nextRuns: ["Tomorrow, 8:00 AM"],
      ref: "a@1",
      statusKind: "active",
      statusLabel: "Active",
      triggerSummary: "Every day at 8am",
      webhook: null,
    },
    plan: { detail: null, label: "Plan ready", state: "ready" },
    runs: [
      {
        costUsd: 0.012,
        dateGroup: "Yesterday",
        durationMs: 3200,
        endedAt: YESTERDAY + 3200,
        originLabel: "Cron",
        entryKind: "run",
        runId: "r1",
        startedAt: YESTERDAY,
        status: "ok",
        summary: "ok run",
      },
      {
        costUsd: null,
        dateGroup: "Today",
        durationMs: 800,
        endedAt: NOW - 60_000 + 800,
        originLabel: "Manual",
        entryKind: "run",
        runId: "r2",
        startedAt: NOW - 60_000,
        status: "fail",
        summary: "failed run",
      },
      {
        costUsd: null,
        dateGroup: "Today",
        durationMs: null,
        endedAt: null,
        originLabel: "Webhook",
        entryKind: "run",
        runId: "r3",
        startedAt: NOW,
        status: "running",
        summary: "in progress",
      },
    ],
    runTokens: { r1: 1234 },
    triggerDetail: {
      conditionDetail: null,
      cronExprs: ["0 8 * * *"],
      dataDetail: null,
    },
    ...over,
  };
}

export function makeProps(
  over: Partial<AutomationThreadBridgeProps> = {},
  data: AutomationThreadDataEx | null = makeData()
): AutomationThreadBridgeProps {
  return {
    loadData: vi.fn().mockResolvedValue(data),
    loadTurnTrace: vi.fn(async (turnId: string) => {
      const text =
        turnId === "r1" ? "ok run" : turnId === "r2" ? "failed run" : "";
      return text
        ? [
            {
              kind: "ai" as const,
              streaming: false as const,
              html: text,
              error: turnId === "r2",
              copyText: text,
              feedback: null,
            },
          ]
        : [];
    }),
    onBack: vi.fn(),
    onCopyWebhook: vi.fn(),
    onDecideConsent: vi.fn().mockResolvedValue(true),
    onDelete: vi.fn().mockResolvedValue(false),
    onOpenCompiler: vi.fn(),
    onOpenRun: vi.fn(),
    onRotateWebhook: vi.fn().mockResolvedValue(true),
    onSetRecognitionVariant: vi.fn().mockResolvedValue(true),
    onRunNow: vi.fn().mockResolvedValue("r-new"),
    onAskAboutRuns: vi.fn().mockResolvedValue("r-message"),
    onToggleEnabled: vi.fn().mockResolvedValue(true),
    watchTurn: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Registers the unmount/cleanup pass. Call once per test file, at top level. */
export function installThreadHarness(): void {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });
}

export async function mount(
  props: AutomationThreadBridgeProps
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AutomationThreadScreen {...props} />);
  });
  return container;
}

/** The DTO lists runs newest-first; the fixture above reads oldest-first. */
export function newestFirst(): AutomationThreadDataEx {
  const data = makeData();
  return { ...data, runs: data.runs.toReversed() };
}

export function byText(
  el: HTMLElement,
  tag: string,
  text: string
): HTMLElement | undefined {
  return [...el.querySelectorAll(tag)].find(
    (n) => n.textContent?.trim() === text
  ) as HTMLElement | undefined;
}
