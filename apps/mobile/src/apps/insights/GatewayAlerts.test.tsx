// Activity's alerts tab, rendered (#1015 R-NY-2). What this pins is the wiring
// the pure model cannot see: "Try again" reaches the real re-run, a line's tap
// reaches its source and marks it read, and a line with nowhere to go is not a
// link. The words are `alerts-model.test.ts`'s.

// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MobileNotice, MobileNotifications } from "../../lib/gateway";
import type { InsightsScreenProps } from "../../navigation";
import { mountBlock, nodesOf, press } from "../../test/react-native-stub";
import GatewayAlerts from "./GatewayAlerts";

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

type Gateway = typeof import("../../lib/gateway");
type Automations = typeof import("../../lib/automations");

const wire = vi.hoisted(() => ({
  notifications: vi.fn<Gateway["getNotifications"]>(),
  run: vi.fn<Automations["runAutomation"]>(),
  updateNotice: vi.fn<Gateway["updateMobileNotice"]>(),
}));

vi.mock(
  import("../../lib/gateway"),
  () =>
    ({
      getNotifications: wire.notifications,
      subscribeMobileNotificationsChanges: () =>
        new Promise<void>(() => {
          // The doorbell never resolves; it is aborted on unmount.
        }),
      updateMobileNotice: wire.updateNotice,
    }) as unknown as Gateway
);
vi.mock(
  import("../../lib/automations"),
  () => ({ runAutomation: wire.run }) as unknown as Automations
);

function notice(over: Partial<MobileNotice> = {}): MobileNotice {
  return {
    archivedAt: null,
    count: 2,
    detail: {
      automationRef: "mail/nightly-digest",
      outcome: "failure",
      sourceType: "automation",
    },
    firstAt: "2026-08-13T06:00:00.000Z",
    headline: "Nightly digest did not finish",
    kind: "automation",
    lastAt: "2026-08-13T08:00:00.000Z",
    noticeId: "n-1",
    readAt: null,
    severity: "high",
    sourceRef: "mail/nightly-digest",
    ...over,
  };
}

function payload(notices: MobileNotice[]): MobileNotifications {
  return {
    decisions: {
      count: 0,
      needsAuth: [],
      outbox: [],
      parked: [],
      scopeRequests: [],
    },
    notices,
    unreadNoticeCount: notices.length,
  };
}

const navigate = vi.fn<(...args: unknown[]) => void>();
const navigation = {
  goBack: vi.fn<() => void>(),
  navigate,
} as unknown as InsightsScreenProps["navigation"];

let dispose: (() => void) | undefined;

/** Two ticks: the mount's deferred read, then the re-read behind a write. */
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
    <GatewayAlerts navigation={navigation} onLeave={() => undefined} />
  );
  dispose = mounted.unmount;
  await settle();
  return mounted.container;
}

function buttons(container: HTMLElement): Element[] {
  return nodesOf(container, "button");
}

describe(GatewayAlerts, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wire.run.mockResolvedValue("turn-1");
    wire.updateNotice.mockResolvedValue(undefined);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("re-runs a failed rule from its line, and says nothing else", async () => {
    wire.notifications.mockResolvedValue(payload([notice()]));
    const container = await render();
    const labels = buttons(container).map((node) => node.textContent ?? "");
    expect(labels).toContain("Try again");
    expect(labels).not.toContain("Mark read");
    expect(labels).not.toContain("Archive");
    // "Failed" once per line: the state word, and nowhere else.
    const text = container.textContent ?? "";
    expect(text.split("Failed")).toHaveLength(2);
    expect(text).not.toContain("×");
    press(buttons(container).find((node) => node.textContent === "Try again"));
    await settle();
    expect(wire.run).toHaveBeenCalledWith("mail/nightly-digest");
  });

  it("opens a line's source from anywhere on it, and marks it read", async () => {
    wire.notifications.mockResolvedValue(payload([notice()]));
    const container = await render();
    const face = buttons(container).find((node) =>
      (node.textContent ?? "").startsWith("Nightly digest did not finish")
    );
    press(face);
    expect(navigate).toHaveBeenCalledWith("Automations", {
      automationRef: "mail/nightly-digest",
    });
    expect(wire.updateNotice).toHaveBeenCalledWith("n-1", "read");
  });

  it("leaves a line with nowhere to go as a line, not a link", async () => {
    wire.notifications.mockResolvedValue(
      payload([
        notice({
          detail: { sourceType: "app" },
          headline: "Tasks imported",
          kind: "app",
          severity: "info",
          sourceRef: "tasks",
        }),
      ])
    );
    const container = await render();
    expect(container.textContent).toContain("Tasks imported");
    // No button carries the line: an app's notice has no screen of its own.
    expect(
      buttons(container).some((node) =>
        (node.textContent ?? "").includes("Tasks imported")
      )
    ).toBe(false);
  });
});
