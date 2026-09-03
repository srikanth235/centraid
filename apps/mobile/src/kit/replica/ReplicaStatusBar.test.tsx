import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingChange } from "./pending-changes";
import { humanStatus, pendingChangeStuckLine } from "./pending-copy";
import ReplicaStatusBar from "./ReplicaStatusBar";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ReactNative = typeof import("react-native");
type NativeTextModule = typeof import("../components/NativeText");
type IconModule = typeof import("../components/Icon");
type OutOfRoomModule = typeof import("../components/OutOfRoom");
type DesignModule = typeof import("@centraid/design");
type ThumbnailPackModule = typeof import("../../lib/replica/thumbnail-pack");
type StorageErrorModule =
  typeof import("../../lib/replica/replica-storage-error");
type PendingChangesModule = typeof import("./pending-changes");
type ReplicaProviderModule = typeof import("./ReplicaProvider");
type ThemeModule = typeof import("../theme");

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style))
    return style.reduce(
      (acc: Record<string, unknown>, s) => Object.assign(acc, flattenStyle(s)),
      {}
    );
  if (typeof style === "object") return style as Record<string, unknown>;
  return {};
}

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  return {
    Alert: { alert: vi.fn<() => void>() },
    Modal: ({
      children,
      visible,
    }: {
      children?: React.ReactNode;
      visible?: boolean;
    }) =>
      visible
        ? ReactModule.createElement("div", { role: "dialog" }, children)
        : null,
    Pressable: ({
      accessibilityLabel,
      accessibilityRole,
      children,
      onPress,
    }: {
      accessibilityLabel?: string;
      accessibilityRole?: string;
      children?: React.ReactNode;
      onPress?: () => void;
    }) =>
      ReactModule.createElement(
        "button",
        {
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          onClick: onPress,
          type: "button",
        },
        children
      ),
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
    StyleSheet: {
      create: <T,>(styles: T): T => styles,
    },
    View: ({
      children,
      style,
    }: {
      children?: React.ReactNode;
      style?: unknown;
    }) =>
      ReactModule.createElement(
        "div",
        { "data-style": JSON.stringify(flattenStyle(style)) },
        children
      ),
  } as unknown as Partial<ReactNative>;
});

vi.mock(
  import("../components/NativeText"),
  () =>
    ({
      Text: ({ children }: { children?: React.ReactNode }) =>
        React.createElement("span", null, children),
    }) as unknown as Partial<NativeTextModule>
);

vi.mock(
  import("../components/Icon"),
  () =>
    ({
      default: ({ name }: { name?: string }) =>
        React.createElement("i", { "data-icon": name }),
    }) as unknown as IconModule
);

vi.mock(
  import("../components/OutOfRoom"),
  () =>
    ({
      default: () => React.createElement("div", null, "out of room"),
    }) as unknown as OutOfRoomModule
);

vi.mock(
  import("@centraid/design"),
  () =>
    ({
      formatRelativeTime: () => "just now",
    }) as unknown as Partial<DesignModule>
);

vi.mock(
  import("../../lib/replica/thumbnail-pack"),
  () =>
    ({
      clearPinnedThumbnailPacks: vi.fn<() => void>(),
    }) as unknown as Partial<ThumbnailPackModule>
);

vi.mock(
  import("../../lib/replica/replica-storage-error"),
  () =>
    ({
      STORAGE_FULL_ACTION_LABEL: "Free up space",
      STORAGE_FULL_CAUSE: "cause",
      STORAGE_FULL_CONSEQUENCE: "consequence",
    }) as unknown as Partial<StorageErrorModule>
);

vi.mock(
  import("../theme"),
  () =>
    ({
      borders: { hairline: 1 },
      family: { sansMedium: "sans-medium", sansRegular: "sans-regular" },
      radii: { lg: 12, md: 7 },
      t: () => ({}),
      useTheme: () => ({
        colors: {
          accent: "#mock-accent",
          bgSunken: "#mock-bg-sunken",
          danger: "#mock-danger",
          line: "#mock-line",
          text: "#mock-text",
          textFaint: "#mock-text-faint",
          textSoft: "#mock-text-soft",
        },
      }),
    }) as unknown as Partial<ThemeModule>
);

const pendingMock = vi.hoisted(() => ({
  pending: [] as unknown[],
  refresh: vi.fn<() => void>(),
}));

vi.mock(
  import("./pending-changes"),
  () =>
    ({
      usePendingChanges: () => pendingMock,
    }) as unknown as Partial<PendingChangesModule>
);

const outbox = vi.hoisted(() => ({ calls: [] as string[][] }));

const sessionMock = vi.hoisted(() => ({
  retryPendingWrite: (intentId: string, vaultId?: string) => {
    outbox.calls.push(["retry", intentId, vaultId ?? ""]);
    return Promise.resolve({ status: "in-flight" });
  },
  discardPendingWrite: (intentId: string, vaultId?: string) => {
    outbox.calls.push(["discard", intentId, vaultId ?? ""]);
    return Promise.resolve(true);
  },
  cancelPendingChange: (id: string, vaultId: string) => {
    outbox.calls.push(["cancel", id, vaultId]);
    return Promise.resolve(true);
  },
  dismissPendingChange: (id: string, vaultId: string) => {
    outbox.calls.push(["dismiss", id, vaultId]);
  },
  resumeAfterStorageFull: () => outbox.calls.push(["resume"]),
}));

const replicaMock = vi.hoisted(() => ({
  coverage: undefined as string | undefined,
  dismissed: [] as string[],
  dismissRevokedNotice: (vaultId: string) => {
    replicaMock.dismissed.push(vaultId);
  },
  reachability: "current" as string,
  refresh: vi.fn<() => void>(),
  revokedNotices: [] as unknown[],
  scopes: [] as unknown[],
  session: undefined as unknown,
  storageFull: false,
}));

vi.mock(
  import("./ReplicaProvider"),
  () =>
    ({
      useReplica: () => replicaMock,
    }) as unknown as Partial<ReplicaProviderModule>
);

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(ReplicaStatusBar));
  });
}

function reset(): void {
  vi.clearAllMocks();
  outbox.calls.length = 0;
  replicaMock.dismissed.length = 0;
  pendingMock.pending = [];
  replicaMock.coverage = undefined;
  replicaMock.reachability = "current";
  replicaMock.revokedNotices = [];
  replicaMock.scopes = [];
  replicaMock.session = undefined;
  replicaMock.storageFull = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

function teardown(): void {
  act(() => root.unmount());
  container.remove();
}

async function press(label: string): Promise<void> {
  const control = container.querySelector(`[aria-label="${label}"]`);
  if (!control) throw new Error(`no control labelled ${label}`);
  await act(async () => {
    control.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("pending-changes chip visibility (issue #711)", () => {
  beforeEach(reset);

  afterEach(teardown);

  it("hides the pending-changes chip when there is nothing pending", async () => {
    pendingMock.pending = [];
    await render();
    expect(container.textContent).not.toContain("Pending changes");
  });

  it("says nothing at all when the replica is current", async () => {
    replicaMock.reachability = "current";
    await render();
    expect(container.textContent).toBe("");
  });

  it("keeps an action only where pulling the grid would not help", async () => {
    replicaMock.reachability = "gateway-asleep";
    await render();
    expect(container.textContent).toContain("Gateway asleep");
    expect(container.textContent).toContain("Wake help");
    expect(container.textContent).not.toContain("Refresh");
  });

  it("shows the pending-changes chip once there is something pending", async () => {
    pendingMock.pending = [{ id: "1" }, { id: "2" }];
    await render();
    expect(container.textContent).toContain("Pending changes");
    expect(container.textContent).toContain("2");
  });
});

const CONFLICT: PendingChange = {
  id: "intent-1",
  vaultId: "home",
  vaultLabel: "Home",
  status: "conflict",
  label: "tally: add_expense",
  appId: "tally",
  action: "add_expense",
  reason: "This row changed somewhere else.",
  expectedVersion: 3,
  actualVersion: 5,
  attempts: 2,
  kind: "replica",
};

describe("the pending sheet's body (issue #880 W2.3)", () => {
  beforeEach(reset);

  afterEach(teardown);

  it("gives a conflict both versions and both doors, in any app", async () => {
    pendingMock.pending = [CONFLICT];
    replicaMock.session = sessionMock;
    await render();
    await press("Pending changes 1");

    expect(container.textContent).toContain("Tally · Add expense");
    expect(container.textContent).toContain("changed somewhere else");
    expect(container.textContent).toContain("Expected version 3; found 5.");
    expect(container.textContent).toContain("Retry");
    expect(container.textContent).toContain("Discard");
    expect(container.textContent).not.toContain("conflict");
    expect(container.textContent).not.toContain("Cancel");
  });

  it("fires Retry against the vault that holds the write", async () => {
    pendingMock.pending = [CONFLICT];
    replicaMock.session = sessionMock;
    await render();
    await press("Pending changes 1");
    await press("Retry Tally · Add expense");

    expect(outbox.calls).toStrictEqual([["retry", "intent-1", "home"]]);
  });

  it("leaves a queued write its Cancel and no outbox verbs", async () => {
    pendingMock.pending = [
      { ...CONFLICT, status: "queued" as const, attempts: 0 },
    ];
    replicaMock.session = sessionMock;
    await render();
    await press("Pending changes 1");

    expect(container.textContent).toContain("waiting to send");
    expect(container.textContent).toContain("Cancel");
    expect(container.textContent).not.toContain("Retry");
    expect(container.textContent).not.toContain("Discard");
  });
});

describe("what else the bar owes a member (issue #880)", () => {
  beforeEach(reset);

  afterEach(teardown);

  it("labels a partial library when no bootstrap is left to report pages", async () => {
    replicaMock.coverage = "partial";
    await render();
    expect(container.textContent).toContain(
      "Recent items ready; older history syncing"
    );
  });

  it("says where the switch is when transfer rules paused the sync", async () => {
    replicaMock.reachability = "sync-paused";
    await render();
    expect(container.textContent).toContain("Sync paused by transfer rules");
    expect(container.textContent).toContain(
      "Change these under Backup health in Settings."
    );
    expect(container.textContent).not.toContain("Sync now");
  });

  it("keeps a revoked scope's one trace until the member dismisses it", async () => {
    replicaMock.revokedNotices = [
      { vaultId: "studio", label: "Studio", at: "2026-08-27T09:00:00.000Z" },
    ];
    await render();
    expect(container.textContent).toContain("No longer shared with you");
    await press("Dismiss Studio");
    expect(replicaMock.dismissed).toStrictEqual(["studio"]);
  });
});

describe("the outbox vocabulary (issue #880 W2.3)", () => {
  it("has a member's word for every state the outbox can be in", () => {
    const states = [
      "queued",
      "sending",
      "in-flight",
      "awaiting-change",
      "parked",
      "denied",
      "conflict",
      "failed",
      "executed",
    ] as const;
    for (const state of states) {
      const said = humanStatus(state);
      expect(said).not.toBe(state);
      expect(said.length).toBeGreaterThan(0);
    }
  });

  it("calls a row stuck only once every ordinary way back has passed", () => {
    const now = Date.parse("2026-08-27T12:00:00.000Z");
    const row = { ...CONFLICT, status: "queued" as const };
    expect(
      pendingChangeStuckLine(
        { ...row, enqueuedAt: "2026-08-27T11:30:00.000Z" },
        now
      )
    ).toBeUndefined();
    const stuck = pendingChangeStuckLine(
      { ...row, enqueuedAt: "2026-08-27T08:00:00.000Z" },
      now
    );
    expect(stuck).toContain("Queued");
    expect(stuck).toContain("2 attempts");
    expect(
      pendingChangeStuckLine(
        { ...CONFLICT, enqueuedAt: "2026-08-27T08:00:00.000Z" },
        now
      )
    ).toBeUndefined();
  });
});
// @vitest-environment jsdom
