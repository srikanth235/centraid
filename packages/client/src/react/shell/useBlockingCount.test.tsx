import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BlockingSummary,
  InboxSummary,
  OutboxItem,
  OutboxNeedsAuth,
} from "../../gateway-client-outbox.js";
import type { VaultParkedEntry } from "../../gateway-client-vault.js";
import type * as TypeImport_bmsl46 from "../../gateway-client.js";
import type * as TypeImport_6f8n6u from "./useBlockingCount.js";

const getInbox = vi.fn<typeof TypeImport_bmsl46.getInbox>();
const subscribeInboxChanges =
  vi.fn<typeof TypeImport_bmsl46.subscribeInboxChanges>();
const syncWebInboxNotifications =
  vi.fn<typeof TypeImport_bmsl46.syncWebInboxNotifications>();
vi.mock(import("../../gateway-client.js"), () => ({
  getInbox: () => getInbox(),
  subscribeInboxChanges: (onChange: () => void, signal?: AbortSignal) =>
    subscribeInboxChanges(onChange, signal),
  syncWebInboxNotifications: () => syncWebInboxNotifications(),
}));

let useBlockingCount: typeof TypeImport_6f8n6u.useBlockingCount;
let root: Root | null = null;
let host: HTMLElement | null = null;

const outboxItem: OutboxItem = {
  itemId: "outbox-1",
  actorId: "app-1",
  connection: { kind: "service", label: "Service" },
  actor: null,
  actorKind: "app",
  verb: "write",
  target: "item",
  artifact: {},
  status: "pending",
  grantId: null,
  stagedAt: "2026-01-01T00:00:00.000Z",
  decidedAt: null,
  drainedAt: null,
  result: null,
  note: null,
  canEdit: false,
};
const needsAuthItem: OutboxNeedsAuth = {
  connectionId: "connection-1",
  kind: "service",
  label: "Service",
  note: null,
  attentionAt: "2026-01-01T00:00:00.000Z",
};
const parkedItem: VaultParkedEntry = {
  invocationId: "invocation-1",
  command: "write",
  parkedAt: "2026-01-01T00:00:00.000Z",
  callerKind: "app",
  callerId: "app-1",
  caller: null,
  input: {},
};

function blockingSummary({
  outbox = 0,
  needsAuth = 0,
  parked = 0,
}: Partial<
  Record<"outbox" | "needsAuth" | "parked", number>
> = {}): BlockingSummary {
  return {
    outbox: Array.from({ length: outbox }, () => outboxItem),
    needsAuth: Array.from({ length: needsAuth }, () => needsAuthItem),
    parked: Array.from({ length: parked }, () => parkedItem),
    scopeRequests: [],
  };
}

function inboxSummary(decisions = blockingSummary()): InboxSummary {
  return {
    decisions: {
      ...decisions,
      count:
        decisions.outbox.length +
        decisions.needsAuth.length +
        decisions.parked.length +
        decisions.scopeRequests.length,
    },
    notices: [],
    unreadNoticeCount: 0,
  };
}

describe("useBlockingCount", () => {
  beforeEach(async () => {
    getInbox.mockReset();
    subscribeInboxChanges.mockReset().mockResolvedValue(undefined);
    syncWebInboxNotifications.mockReset().mockResolvedValue(undefined);
    ({ useBlockingCount } = await import("./useBlockingCount.js"));
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function Harness() {
    return <output data-testid="blocking-count">{useBlockingCount()}</output>;
  }
  function count(): number {
    return Number(
      host?.querySelector("[data-testid=blocking-count]")?.textContent
    );
  }
  async function mount(): Promise<void> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Harness />);
    });
  }

  describe("useBlockingCount", () => {
    it("sums all four blocking groups", async () => {
      getInbox.mockResolvedValue(
        inboxSummary(blockingSummary({ outbox: 2, needsAuth: 1, parked: 3 }))
      );
      await mount();
      expect(count()).toBe(6);
    });

    it("stays at the last known count when the gateway is unreachable", async () => {
      getInbox.mockRejectedValue(new Error("offline"));
      await mount();
      expect(count()).toBe(0);
    });

    it("refreshes on window focus", async () => {
      getInbox.mockResolvedValue(inboxSummary());
      await mount();
      expect(count()).toBe(0);
      getInbox.mockResolvedValue(inboxSummary(blockingSummary({ outbox: 1 })));
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(count()).toBe(1);
    });
  });
});
