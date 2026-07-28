import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  RunViewBridgeProps,
  RunViewSnapshot,
} from "../screen-contracts.js";
import RunViewScreen from "./RunViewScreen.js";

function makeSnapshot(over: Partial<RunViewSnapshot> = {}): RunViewSnapshot {
  return {
    messages: [
      {
        kind: "user",
        text: "Summarize the inbox.",
        createdAt: Date.now() - 4000,
      },
      {
        kind: "tools",
        label: "1 tool",
        calls: [{ tool: "gmail.search", state: "ok", meta: "1s" }],
      },
      {
        kind: "ai",
        streaming: false,
        html: "<p>Done — 12 emails.</p>",
        error: false,
        copyText: "Done — 12 emails.",
      },
    ],
    crumbName: "Daily Digest",
    glyphIcon: "Bolt",
    hue: "indigo",
    headerName: "Daily Digest",
    startedLabel: "Today, 6:00:02 PM",
    model: "claude-opus-4-8",
    statusKind: "success",
    statusLabel: "Completed",
    inFlight: false,
    deleted: false,
    triggerLabel: "Every day at 8am",
    triggersSummary: "Every day at 8am",
    triggerHeroIcon: "Clock",
    promptInstr: "Summarize the inbox.",
    final: {
      kind: "ok",
      model: "claude-opus-4-8",
      summary: "Done — 12 emails.",
    },
    side: {
      outcomeKind: "success",
      outcomeLabel: "Completed",
      trigger: "cron",
      duration: "4s",
      started: "5/19/2026, 6:00 PM",
      runId: "r1",
      tokens: "1.2k",
      cost: "$0.40",
      steps: "2",
      model: "claude-opus-4-8",
      hasUsage: true,
    },
    logKpi: {
      triggerIcon: "Clock",
      triggerLabel: "Cron",
      tokens: "1.2k",
      cost: "$0.400",
      duration: "4s",
    },
    logRows: [
      {
        time: "00:00.0",
        tone: "trigger",
        label: "Run started by cron",
        sub: "Every day at 8am",
      },
      {
        time: "00:01.2",
        tone: "ok",
        label: "gmail.search",
        sub: "tool",
        input: '{ "q": "is:unread" }',
      },
      {
        time: "00:04.0",
        tone: "ok",
        label: "Run completed",
        sub: "Done — 12 emails.",
      },
    ],
    ...over,
  };
}

function makeProps(over: Partial<RunViewBridgeProps> = {}): RunViewBridgeProps {
  return {
    initialMode: "timeline",
    onReady: vi.fn<RunViewBridgeProps["onReady"]>(),
    onBack: vi.fn<RunViewBridgeProps["onBack"]>(),
    onOpenAutomation: vi.fn<RunViewBridgeProps["onOpenAutomation"]>(),
    onRunAgain: vi.fn<RunViewBridgeProps["onRunAgain"]>(),
    onSetMode: vi.fn<RunViewBridgeProps["onSetMode"]>(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let update: ((s: RunViewSnapshot | null) => void) | null = null;
describe("screens/RunViewScreen", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    update = null;
    vi.clearAllMocks();
  });
  function mount(props: RunViewBridgeProps): HTMLDivElement {
    container = document.createElement("div");
    document.body.appendChild(container);
    // capture the update fn the screen hands back via onReady
    const onReady = (u: (s: RunViewSnapshot | null) => void): void => {
      update = u;
    };
    act(() => {
      root = createRoot(container as HTMLDivElement);
      root.render(<RunViewScreen {...props} onReady={onReady} />);
    });
    return container;
  }
  function push(snap: RunViewSnapshot | null): void {
    act(() => update?.(snap));
  }

  describe(RunViewScreen, () => {
    it("shows a loading state until the first snapshot arrives, with a back affordance", () => {
      const props = makeProps();
      const el = mount(props);
      expect(el.textContent).toContain("Loading run…");
      // The loading state must never strand the user without a way back.
      const crumbBtn = el.querySelector(".auCrumb button") as HTMLButtonElement;
      expect(crumbBtn).toBeTruthy();
      void act(() =>
        crumbBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(props.onBack).toHaveBeenCalledWith(
        expect.objectContaining({ type: "click" })
      );
      push(makeSnapshot());
      expect(el.querySelector(".rv")).toBeTruthy();
      expect(el.textContent).not.toContain("Loading run…");
    });

    it("renders a deleted-automation notice and hides actions requiring the automation", () => {
      const props = makeProps();
      const el = mount(props);
      push(
        makeSnapshot({
          deleted: true,
          crumbName: "digest/main",
          headerName: "digest/main",
          promptInstr:
            "This automation was deleted. Its instructions are no longer available.",
        })
      );
      expect(el.textContent).toContain("This automation was deleted");
      expect(el.textContent).toContain("digest/main");
      // The loaded run detail has no in-page breadcrumb (shell chrome owns back).
      expect(el.querySelector(".auCrumb")).toBeNull();
      // "Run again" requires a live automation row — hidden when deleted.
      const runAgain = [...el.querySelectorAll(".auBtn")].find((b) =>
        b.textContent?.includes("Run again")
      );
      expect(runAgain).toBeUndefined();
    });

    it("renders the timeline through the shared conversation messages", () => {
      const el = mount(makeProps());
      push(makeSnapshot());
      expect(el.querySelector(".rvHeadName")?.textContent).toContain(
        "Daily Digest"
      );
      // Trigger + one native conversation transcript.
      expect(el.querySelectorAll(".tlItem")).toHaveLength(2);
      expect(
        el.querySelector('[data-testid="automation-turn-messages"]')
      ).toBeTruthy();
      expect(el.textContent).toContain("gmail.search");
      expect(el.textContent).toContain("Done — 12 emails.");
      expect(el.querySelector(".rside")).toBeTruthy();
      expect(el.textContent).toContain("claude-opus-4-8");
    });

    it("uses the shared expandable tool group", () => {
      const el = mount(makeProps());
      push(makeSnapshot());
      const details = el.querySelector(".tools") as HTMLDetailsElement;
      expect(details.open).toBe(false);
      void act(() =>
        details
          .querySelector("summary")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(details.open).toBe(true);
    });

    it('renders log mode when opened with initialMode "log"', () => {
      const el = mount(makeProps({ initialMode: "log" }));
      push(makeSnapshot());
      expect(el.querySelector(".log")).toBeTruthy();
      expect(el.querySelectorAll(".logRow")).toHaveLength(3);
      expect(el.querySelector(".tl")).toBeNull();
    });

    it("renders the assistant answer with the shared AI message", () => {
      const el = mount(makeProps());
      push(makeSnapshot());
      expect(el.querySelector(".msgAi")?.textContent).toContain(
        "Done — 12 emails."
      );
    });

    it("renders turn failures through the shared error message", () => {
      const el = mount(makeProps());
      push(
        makeSnapshot({
          statusKind: "failed",
          statusLabel: "Failed",
          final: { kind: "fail", model: "claude-opus-4-8", error: "boom" },
          messages: [
            {
              kind: "ai",
              streaming: false,
              html: "<p>boom</p>",
              error: true,
              copyText: "boom",
            },
          ],
        })
      );
      expect((el.querySelector(".msgAi") as HTMLElement).dataset.error).toBe(
        "true"
      );
      expect(el.textContent).toContain("boom");
    });

    it("always shows the Model row, plus token/cost/step rows when usage exists", () => {
      const el = mount(makeProps());
      push(makeSnapshot());
      const usageCard = [...el.querySelectorAll(".rsideCard")].find((c) =>
        c.textContent?.includes("Usage")
      );
      expect(usageCard?.textContent).toContain("Model");
      expect(usageCard?.textContent).toContain("claude-opus-4-8");
      expect(usageCard?.textContent).toContain("Tokens");
      expect(usageCard?.textContent).toContain("Steps");
      expect(usageCard?.querySelector(".rsideEmpty")).toBeNull();
    });

    it("collapses token/cost/step rows to a caption for a deterministic run", () => {
      const el = mount(makeProps());
      push(makeSnapshot({ side: { ...makeSnapshot().side, hasUsage: false } }));
      const usageCard = [...el.querySelectorAll(".rsideCard")].find((c) =>
        c.textContent?.includes("Usage")
      );
      expect(usageCard?.textContent).toContain("Model");
      expect(usageCard?.querySelector(".rsideEmpty")?.textContent).toContain(
        "deterministic"
      );
      expect(usageCard?.textContent).not.toContain("Tokens");
    });

    it("renders no run-view controls — the detail is a single calm view", () => {
      const el = mount(makeProps());
      push(makeSnapshot());
      // No Timeline/Log toggle, no details-collapse button, no Run again.
      expect(el.querySelector(".rvSeg")).toBeNull();
      expect(el.querySelector(".rvHeadActions")).toBeNull();
      const controls = [...el.querySelectorAll(".rvHead button")];
      expect(controls).toHaveLength(0);
      // The side panel is always present.
      expect(el.querySelector(".rside")).toBeTruthy();
    });

    it("shows a pending final node while in flight", () => {
      const el = mount(makeProps());
      push(
        makeSnapshot({
          inFlight: true,
          statusKind: "running",
          statusLabel: "Running",
          final: { kind: "pending", model: "claude-opus-4-8" },
          messages: [],
        })
      );
      expect(el.querySelector(".pending")).toBeTruthy();
      expect(el.textContent).toContain("updates live");
    });
  });
});
