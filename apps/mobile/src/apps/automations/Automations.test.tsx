// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTheme } from "../../kit/theme";
import type { AutomationRow, AutomationTurnRow } from "../../lib/automations";
import { MOBILE_FEATURE_OFF_COPY } from "../../lib/replica/mobile-gateway-compatibility-core";
import type { AutomationsScreenProps } from "../../navigation";
import {
  mountBlock,
  nodesOf,
  press,
  styleOf,
} from "../../test/react-native-stub";
import AutomationsScreen from "./Automations";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return {
    ...stub.reactNativeStub(),
    RefreshControl: () => null,
  } as unknown as typeof import("react-native");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});
vi.mock(import("react-native-safe-area-context"), () => ({
  useSafeAreaInsets: () => ({ bottom: 34, left: 0, right: 0, top: 47 }),
}));

const session = vi.hoisted(() => ({
  features: undefined as
    | { automations: boolean; connectors: boolean }
    | undefined,
}));
vi.mock(import("../../kit/replica/ReplicaProvider"), () => ({
  useReplica: () => ({ online: true, ready: true, ...session }),
}));

type Automations = typeof import("../../lib/automations");

const wire = vi.hoisted(() => ({
  clone: vi.fn<Automations["cloneAutomationTemplate"]>(),
  list: vi.fn<Automations["listAutomations"]>(),
  setEnabled: vi.fn<Automations["setAutomationEnabled"]>(),
  templates: vi.fn<Automations["listAutomationTemplates"]>(),
  turns: vi.fn<Automations["listAutomationTurns"]>(),
}));

vi.mock(import("../../lib/automations"), () => ({
  cloneAutomationTemplate: wire.clone,
  listAutomations: wire.list,
  listAutomationTemplates: wire.templates,
  listAutomationTurns: wire.turns,
  runAutomation: vi.fn<Automations["runAutomation"]>(),
  setAutomationEnabled: wire.setEnabled,
}));
vi.mock(
  import("../../lib/gateway"),
  () =>
    ({
      resolveGatewayBase: () => Promise.resolve("http://127.0.0.1:7777"),
    }) as unknown as typeof import("../../lib/gateway")
);

const colors = resolveTheme("light").colors;
const HOUR = 3_600_000;

function row(over: Partial<AutomationRow> = {}): AutomationRow {
  return {
    description: "",
    enabled: true,
    id: "digest",
    name: "Weekly digest",
    ref: "mail/digest",
    scheduleLabel: "Monday 8:00",
    ...over,
  };
}

function turn(over: Partial<AutomationTurnRow> = {}): AutomationTurnRow {
  return {
    ok: true,
    startedAt: Date.now() - HOUR,
    summary: "3 files",
    triggerKind: "cron",
    turnId: "t1",
    ...over,
  };
}

const navigation = {
  goBack: vi.fn<() => void>(),
  push: vi.fn<(name: string, params: unknown) => void>(),
} as unknown as AutomationsScreenProps["navigation"];

let dispose: (() => void) | undefined;

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function render(): Promise<HTMLElement> {
  const mounted = mountBlock(
    <AutomationsScreen
      navigation={navigation}
      route={
        {
          key: "autos",
          name: "Automations",
        } as AutomationsScreenProps["route"]
      }
    />
  );
  dispose = mounted.unmount;
  await settle();
  return mounted.container;
}

function textOf(container: HTMLElement): string[] {
  return nodesOf(container, "span").map((node) => node.textContent ?? "");
}

function buttonLabelled(container: HTMLElement, label: string): Element | null {
  return (
    nodesOf(container, "button").find(
      (node) => (node.textContent ?? "").trim() === label
    ) ?? null
  );
}

describe(AutomationsScreen, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.features = undefined;
    wire.list.mockResolvedValue([]);
    wire.turns.mockResolvedValue([]);
    wire.templates.mockResolvedValue([]);
    wire.clone.mockResolvedValue(undefined);
    wire.setEnabled.mockResolvedValue(undefined);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("walls the place when the gateway has automations switched off", async () => {
    session.features = { automations: false, connectors: true };
    const container = await render();
    expect(textOf(container).join(" ")).toContain(
      MOBILE_FEATURE_OFF_COPY.automations.title
    );
    expect(wire.list).not.toHaveBeenCalled();
  });

  it("draws the page when the gateway has automations switched on", async () => {
    session.features = { automations: true, connectors: false };
    wire.list.mockResolvedValue([row()]);
    const container = await render();
    const spans = textOf(container).join(" ");
    expect(spans).toContain("Weekly digest");
    expect(spans).not.toContain(MOBILE_FEATURE_OFF_COPY.automations.title);
  });

  it("draws the row geometry while it reads, and says why", async () => {
    wire.list.mockReturnValue(new Promise<AutomationRow[]>(() => {}));
    const container = await render();
    const skeleton = nodesOf(container, "div").find(
      (node) => node.dataset.role === "progressbar"
    );
    expect(skeleton?.getAttribute("aria-label")).toBe(
      "Reading your automations"
    );
    const spans = textOf(container);
    expect(spans).toContain(
      "A row knows its shape before its content arrives, so nothing reflows when it does."
    );
    expect(spans).toContain("Reading from the gateway");
  });

  it("says what an automation is, quietly, when nothing runs on its own", async () => {
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("Nothing runs on its own yet");
    expect(spans).toContain("An automation is a trigger and a thing to do.");
    expect(spans).toContain("Nothing to attend to");
  });

  it("reports a failed read as a net panel with no invented clock", async () => {
    wire.list.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("The scheduler is not answering");
    expect(spans).toContain("Runs queue until the scheduler is back.");
    expect(spans).toContain("connect ECONNREFUSED");
    const panel = nodesOf(container, "div").find(
      (node) => styleOf(node).borderColor === colors.net
    );
    expect(panel).toBeDefined();
    expect(buttonLabelled(container, "Reconnect")).not.toBeNull();
    expect(spans).toContain("This page could not load");
  });

  it("tones a failing row's metadata, never its name, and names it once at the foot", async () => {
    wire.list.mockResolvedValue([row()]);
    wire.turns.mockResolvedValue([
      turn({ error: "Gmail token expired", ok: false, turnId: "t2" }),
      turn({
        error: "Gmail token expired",
        ok: false,
        startedAt: Date.parse("2026-08-04T08:00:00.000Z"),
        turnId: "t1",
      }),
    ]);
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("Weekly digest");
    expect(spans).toContain("Failing");
    expect(
      spans.some((span) =>
        span.startsWith("Monday 8:00 · failed 2 runs in a row, since ")
      )
    ).toBe(true);
    const title = nodesOf(container, "span").find(
      (node) => node.textContent === "Weekly digest"
    );
    expect(styleOf(title).color).toBe(colors.text);
    expect(
      spans.some((span) =>
        span.startsWith(
          "1 automation is failing · Weekly digest has failed its last 2 runs, since "
        )
      )
    ).toBe(true);

    press(buttonLabelled(container, "Open the failure"));
    expect(navigation.push).toHaveBeenCalledWith("Automations", {
      automationRef: "mail/digest",
    });
  });

  it("keeps both halves of the pause write, through the gateway", async () => {
    wire.list.mockResolvedValue([
      row(),
      row({
        enabled: false,
        id: "tidy",
        name: "Tidy downloads",
        ref: "files/tidy",
      }),
    ]);
    const container = await render();
    expect(textOf(container)).toContain("Paused");
    press(buttonLabelled(container, "Pause"));
    await settle();
    expect(wire.setEnabled).toHaveBeenCalledWith("mail/digest", false);
    press(buttonLabelled(container, "Resume"));
    await settle();
    expect(wire.setEnabled).toHaveBeenCalledWith("files/tidy", true);
  });

  it("lists recent runs across everything, and opens the one you pick", async () => {
    wire.list.mockResolvedValue([row()]);
    wire.turns.mockResolvedValue([turn()]);
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("Recent runs across everything");
    expect(
      spans.some((span) => span.startsWith("Succeeded · 3 files · "))
    ).toBe(true);
    press(buttonLabelled(container, "View"));
    expect(navigation.push).toHaveBeenCalledWith("Automations", {
      automationRef: "mail/digest",
    });
  });

  it("tells the truth about where suggestions come from, and creates one", async () => {
    wire.templates.mockResolvedValue([
      {
        desc: "Pull mail into the vault",
        id: "google-gmail-pull",
        name: "Gmail",
        triggerLabel: "Every 15 minutes",
      },
    ]);
    wire.list.mockResolvedValue([row()]);
    const container = await render();
    expect(textOf(container)).toContain(
      "Suggestions come from the template catalogue, not from watching you."
    );
    press(buttonLabelled(container, "Create"));
    await settle();
    expect(wire.clone).toHaveBeenCalledWith("google-gmail-pull");
  });

  it("earns its filter chips only once the list is full", async () => {
    wire.list.mockResolvedValue([row(), row({ id: "b", ref: "a/b" })]);
    const few = await render();
    expect(buttonLabelled(few, "Failing")).toBeNull();
    dispose?.();

    wire.list.mockResolvedValue(
      Array.from({ length: 9 }, (_unused, index) =>
        row({ id: `a${String(index)}`, ref: `app/a${String(index)}` })
      )
    );
    const many = await render();
    expect(buttonLabelled(many, "All")).not.toBeNull();
    expect(buttonLabelled(many, "Drafts")).not.toBeNull();
  });

  it("carries no filled commit, because no author flow exists here", async () => {
    wire.list.mockResolvedValue([row()]);
    const container = await render();
    expect(buttonLabelled(container, "New automation")).toBeNull();
    expect(textOf(container)).toContain("Automations");
  });
});
