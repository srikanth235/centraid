import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AuOverviewData,
  AutomationsOverviewBridgeProps,
} from "../screen-contracts.js";
import { readVitals, resetVitals } from "../shell/routeVitals.js";
import { readRouteHealth, setRouteHealth } from "../shell/statusChannel.js";
import AutomationsOverviewScreen from "./AutomationsOverviewScreen.js";

const DAY = 86_400_000;

function makeData(over: Partial<AuOverviewData> = {}): AuOverviewData {
  return {
    subtitle: "unused — the count line is derived from rows",
    health: { active: 1, paused: 1, drafts: 0, attention: 1 },
    rows: [
      {
        ref: "a@1",
        id: "a",
        name: "Daily Digest",
        hue: "indigo",
        glyphIcon: "Bolt",
        triggerIcon: "Clock",
        triggerLabel: "Every day at 8am",
        integrations: ["Gmail"],
        lastRunLabel: "Last run 2h ago",
        lastRunOk: true,
        lastRunSummary: "Emailed your morning digest",
        nextRunLabel: "Tomorrow, 8:00 AM",
        attentionCount: 0,
        recentFailover: true,
        statusKind: "active",
        statusLabel: "Active",
      },
      {
        ref: "b@1",
        id: "b",
        name: "Invoice Sync",
        hue: "rose",
        glyphIcon: "Webhook",
        triggerIcon: "Webhook",
        triggerLabel: "Webhook",
        integrations: [],
        lastRunLabel: "Last run 1d ago",
        lastRunOk: false,
        lastRunSummary: "Timed out reaching the billing API",
        nextRunLabel: null,
        attentionCount: 2,
        statusKind: "paused",
        statusLabel: "Paused",
      },
    ],
    runs: [
      {
        runId: "r1",
        automationId: "a@1",
        ok: true,
        name: "Daily Digest",
        summary: "Summarized 12 emails",
        whenLabel: "2h ago",
        metaLabel: "Cron · 3s · 1.2k",
        startedAt: Date.now(),
      },
      {
        runId: "r2",
        automationId: "b@1",
        ok: false,
        name: "Invoice Sync",
        summary: "API error",
        whenLabel: "1d ago",
        metaLabel: "Webhook · 1s · 0.3k",
        startedAt: Date.now() - DAY,
      },
    ],
    ...over,
  };
}

function bigData(): AuOverviewData {
  const base = makeData();
  const extra = Array.from({ length: 8 }, (_unused, i) => ({
    ...base.rows[0]!,
    ref: `x${i}@1`,
    id: `x${i}`,
    name: `Filler ${i}`,
    attentionCount: 0,
    recentFailover: false,
    lastRunOk: true,
    statusKind: i === 0 ? ("draft" as const) : ("active" as const),
    statusLabel: i === 0 ? "Draft" : "Active",
  }));
  return { ...base, rows: [...base.rows, ...extra] };
}

function makeProps(
  over: Partial<AutomationsOverviewBridgeProps> = {}
): AutomationsOverviewBridgeProps {
  return {
    loadData: vi
      .fn<AutomationsOverviewBridgeProps["loadData"]>()
      .mockResolvedValue(makeData()),
    onOpenAutomation:
      vi.fn<AutomationsOverviewBridgeProps["onOpenAutomation"]>(),
    onOpenRun: vi.fn<AutomationsOverviewBridgeProps["onOpenRun"]>(),
    onBrowseTemplates:
      vi.fn<AutomationsOverviewBridgeProps["onBrowseTemplates"]>(),
    ...over,
  };
}

function buttons(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll("button")];
}

function rowAction(el: HTMLElement, title: string): HTMLButtonElement {
  const found = buttons(el).find((b) => b.title === title);
  expect(found, `no control titled “${title}”`).toBeTruthy();
  return found as HTMLButtonElement;
}

function click(node: HTMLElement | undefined): Promise<void> {
  return act(async () => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe("AutomationsOverviewScreen suite", () => {
  beforeEach(() => {
    resetVitals();
    setRouteHealth(null);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });
  async function mount(
    props: AutomationsOverviewBridgeProps
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<AutomationsOverviewScreen {...props} />);
    });
    return container;
  }

  describe(AutomationsOverviewScreen, () => {
    it("renders the two sections as row blocks, attention-first", async () => {
      const el = await mount(makeProps());
      expect(el.textContent).toContain("Automations");
      expect(el.textContent).toContain("Recent runs across everything");
      expect(el.textContent).toContain("Every day at 8am");
      expect(el.textContent).toContain("Last run 2h ago");
      expect(el.textContent).toContain("2 items waiting on you");
      expect(el.textContent).toContain("ran on a fallback harness");
      const titles = [...el.querySelectorAll("fieldset")][0]
        ?.textContent as string;
      expect(titles.indexOf("Invoice Sync")).toBeLessThan(
        titles.indexOf("Daily Digest")
      );
    });

    it("tones the failing automation's row net and words its meta 'Failing'", async () => {
      const el = await mount(makeProps());
      const netRows = [...el.querySelectorAll('[data-net="true"]')];
      expect(netRows).toHaveLength(2);
      expect(netRows[0]?.textContent).toContain("Invoice Sync");
      expect(netRows[0]?.textContent).toContain("Failing");
      expect(el.textContent).toContain("Active");
    });

    it("states the failure streak from the run feed, in the row and the status line", async () => {
      const data = makeData();
      const el = await mount(
        makeProps({
          loadData: vi
            .fn<AutomationsOverviewBridgeProps["loadData"]>()
            .mockResolvedValue({
              ...data,
              runs: [
                data.runs[0]!,
                { ...data.runs[1]!, runId: "f1", startedAt: Date.now() - DAY },
                {
                  ...data.runs[1]!,
                  runId: "f2",
                  startedAt: Date.now() - 2 * DAY,
                },
                {
                  ...data.runs[1]!,
                  runId: "f3",
                  startedAt: Date.now() - 3 * DAY,
                },
                {
                  ...data.runs[1]!,
                  runId: "ok0",
                  ok: true,
                  startedAt: Date.now() - 4 * DAY,
                },
              ],
            }),
        })
      );
      expect(el.textContent).toContain("failed 3 runs in a row, since");
      const health = readRouteHealth();
      expect(health?.text).toContain("1 automation failing");
      expect(health?.text).toContain(
        "Invoice Sync has failed its last 3 runs, since"
      );
      expect(health?.action?.label).toBe("Open the failure");
      expect(health?.tone).toBe("net");
    });

    it("opens the failing automation from the status line's inline verb", async () => {
      const props = makeProps();
      await mount(props);
      readRouteHealth()?.action?.run();
      expect(props.onOpenAutomation).toHaveBeenCalledWith("b@1");
    });

    it("publishes the count line and the ready state to the app bar", async () => {
      await mount(makeProps());
      expect(readVitals("automations")).toStrictEqual({
        count: "2 automations · 1 failing · 1 paused",
        state: "ready",
      });
    });

    it("says nothing is failing when nothing is", async () => {
      const data = makeData();
      await mount(
        makeProps({
          loadData: vi
            .fn<AutomationsOverviewBridgeProps["loadData"]>()
            .mockResolvedValue({
              ...data,
              rows: [data.rows[0]!],
              runs: [data.runs[0]!],
            }),
        })
      );
      expect(readRouteHealth()?.text).toContain("Nothing is failing");
      expect(readRouteHealth()?.action).toBeUndefined();
      expect(readVitals("automations")?.count).toBe(
        "1 automation · 0 failing · 0 paused"
      );
    });

    it("opens an automation and a run from their row actions", async () => {
      const props = makeProps();
      const el = await mount(props);
      await click(rowAction(el, "Open Invoice Sync"));
      expect(props.onOpenAutomation).toHaveBeenCalledWith("b@1");
      await click(rowAction(el, "View the Daily Digest run from 2h ago"));
      expect(props.onOpenRun).toHaveBeenCalledWith("a@1", "r1");
    });

    it("shows the filter chips only when the fleet is full, and filters on them", async () => {
      const small = await mount(makeProps());
      expect(
        small.querySelector('[aria-label="Filter automations"]')
      ).toBeNull();
      act(() => root?.unmount());
      small.remove();

      const el = await mount(
        makeProps({
          loadData: vi
            .fn<AutomationsOverviewBridgeProps["loadData"]>()
            .mockResolvedValue(bigData()),
        })
      );
      const chips = el.querySelector('[aria-label="Filter automations"]');
      expect(chips).toBeTruthy();
      expect(readVitals("automations")?.state).toBe("full");
      await click(
        buttons(el).find((b) => b.textContent === "Failing") as HTMLElement
      );
      expect(el.textContent).toContain("1 of 10");
      expect(el.textContent).toContain("Invoice Sync");
      expect(el.textContent).not.toContain("Filler 1");
      await click(
        buttons(el).find((b) => b.textContent === "Drafts") as HTMLElement
      );
      const list = el.querySelector(
        '[aria-label="Automations"]'
      ) as HTMLElement;
      expect(list.textContent).toContain("Filler 0");
      expect(list.textContent).not.toContain("Invoice Sync");
    });

    it("renders the routine empty state and publishes the empty state", async () => {
      const props = makeProps({
        loadData: vi
          .fn<AutomationsOverviewBridgeProps["loadData"]>()
          .mockResolvedValue(makeData({ rows: [], runs: [] })),
      });
      const el = await mount(props);
      expect(el.textContent).toContain("Nothing runs on its own yet");
      expect(el.textContent).toContain(
        "An automation is a trigger and a thing to do."
      );
      expect(readVitals("automations")?.state).toBe("empty");
      expect(buttons(el).some((b) => b.textContent === "New automation")).toBe(
        false
      );
      await click(
        buttons(el).find((b) => b.textContent === "Browse templates")
      );
      expect(props.onBrowseTemplates).toHaveBeenCalledOnce();
    });

    it("renders the Worth setting up section and creates from it", async () => {
      const onUseSuggestion =
        vi.fn<NonNullable<AutomationsOverviewBridgeProps["onUseSuggestion"]>>();
      const el = await mount(
        makeProps({
          loadSuggestions: vi
            .fn<
              NonNullable<AutomationsOverviewBridgeProps["loadSuggestions"]>
            >()
            .mockResolvedValue([
              {
                id: "obligation-extractor",
                name: "Document deadlines",
                desc: "Pull due dates from docs",
                triggerLabel: "When a document lands",
              },
            ]),
          onUseSuggestion,
        })
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(el.textContent).toContain("Worth setting up");
      expect(el.textContent).toContain("Document deadlines");
      expect(el.textContent).toContain(
        "Suggestions come from the template catalogue, not from watching you."
      );
      await click(rowAction(el, "Create Document deadlines"));
      expect(onUseSuggestion).toHaveBeenCalledWith("obligation-extractor");
    });

    it("keeps built-in recognition recipes and runs in their own sections", async () => {
      const data = makeData();
      const el = await mount(
        makeProps({
          loadData: vi
            .fn<AutomationsOverviewBridgeProps["loadData"]>()
            .mockResolvedValue({
              ...data,
              rows: [
                ...data.rows,
                {
                  ...data.rows[0]!,
                  id: "photo-ocr",
                  ref: "photo-ocr/photo-ocr",
                  name: "Photo OCR",
                  systemLane: "recognition" as const,
                },
              ],
              runs: [
                ...data.runs,
                {
                  ...data.runs[0]!,
                  automationId: "photo-ocr/photo-ocr",
                  runId: "recognition-run",
                  name: "Photo OCR",
                  systemLane: "recognition" as const,
                },
              ],
            }),
        })
      );
      expect(el.textContent).toContain("Recognition");
      expect(el.textContent).toContain("Recognition history");
      expect(readVitals("automations")?.count).toBe(
        "2 automations · 1 failing · 1 paused"
      );
      const recipes = el.querySelector(
        '[aria-label="Recognition recipes"]'
      ) as HTMLElement;
      expect(recipes.textContent).toContain("Photo OCR");
    });

    it("keeps the member run list populated when the recognition lane floods it", async () => {
      const data = makeData();
      const flood = Array.from({ length: 100 }, (_unused, i) => ({
        ...data.runs[0]!,
        automationId: "photo-ocr/photo-ocr",
        runId: `recognition-run-${i}`,
        name: "Photo OCR",
        systemLane: "recognition" as const,
      }));
      const el = await mount(
        makeProps({
          loadData: vi
            .fn<AutomationsOverviewBridgeProps["loadData"]>()
            .mockResolvedValue({ ...data, runs: [...flood, ...data.runs] }),
        })
      );
      const recent = el.querySelector(
        '[aria-label="Recent runs"]'
      ) as HTMLElement;
      expect(recent.textContent).toContain("Daily Digest");
      expect(recent.textContent).toContain("Invoice Sync");
      expect(recent.textContent).not.toContain("Photo OCR");
    });

    it("renders the skeleton and the reflow note while reading", async () => {
      let settle: (data: AuOverviewData) => void = () => undefined;
      const el = await mount(
        makeProps({
          loadData: vi
            .fn<AutomationsOverviewBridgeProps["loadData"]>()
            .mockReturnValue(
              new Promise<AuOverviewData>((resolve) => {
                settle = resolve;
              })
            ),
        })
      );
      expect(
        el.querySelector('[data-testid="automations-loading"]')
      ).toBeTruthy();
      expect(el.textContent).toContain("A row knows its shape");
      expect(readVitals("automations")?.state).toBe("loading");
      await act(async () => {
        settle(makeData());
        await Promise.resolve();
      });
      expect(
        el.querySelector('[data-testid="automations-overview"]')
      ).toBeTruthy();
    });

    it("renders the net error panel + Reconnect when loadData rejects", async () => {
      const loadData = vi
        .fn<AutomationsOverviewBridgeProps["loadData"]>()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(makeData());
      const el = await mount(makeProps({ loadData }));
      const panel = el.querySelector(
        '[data-testid="automations-error"]'
      ) as HTMLElement;
      expect(panel.textContent).toContain("The scheduler is not answering");
      expect(panel.textContent).toContain(
        "Runs queue until the scheduler is back."
      );
      expect(panel.textContent).not.toContain("Nothing has run since");
      expect(panel.textContent).toContain("boom");
      expect(readVitals("automations")?.state).toBe("error");
      await click(buttons(el).find((b) => b.textContent === "Reconnect"));
      expect(loadData).toHaveBeenCalledTimes(2);
      expect(el.textContent).toContain("Daily Digest");
    });

    it("does not re-fetch when the parent swaps loadData identity (stable Reconnect)", async () => {
      const first = vi
        .fn<AutomationsOverviewBridgeProps["loadData"]>()
        .mockRejectedValue(new Error("gateway 500"));
      const second = vi
        .fn<AutomationsOverviewBridgeProps["loadData"]>()
        .mockRejectedValue(new Error("still 500"));
      const el = await mount(makeProps({ loadData: first }));
      expect(el.textContent).toContain("The scheduler is not answering");
      expect(first).toHaveBeenCalledOnce();

      await act(async () => {
        root!.render(
          <AutomationsOverviewScreen {...makeProps({ loadData: second })} />
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(el.textContent).toContain("The scheduler is not answering");
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledTimes(0);
      second.mockResolvedValueOnce(makeData());
      await click(buttons(el).find((b) => b.textContent === "Reconnect"));
      expect(second).toHaveBeenCalledOnce();
      expect(el.textContent).toContain("Daily Digest");
    });
  });
});
