// The Notifications place, rendered (#765, spec §2). Five states, one screen.
//
// What this pins is what a future edit is likeliest to undo quietly:
//
//  - loading draws the ROW GEOMETRY plus the sentence that explains why, and
//    never a spinner
//  - the head of the queue is a PANEL whose body is quoted and whose last fact
//    is the verbatim promise that approving cannot be undone
//  - approve, edit-and-approve and deny reach the real mutations, with the
//    always-allow flag carried through
//  - a decision in flight WITHDRAWS its verbs rather than dimming them
//  - the queue's reference tail (standing grants, updates, the archive) is
//    present even when nothing is waiting
//  - empty and error are the reference's verbatim copy, and an unpaired phone
//    is the error state with a way forward, not a sixth visual

// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MobileNotifications, MobileOutboxRow } from "../../lib/gateway";
import type { SettingsScreenProps } from "../../navigation";
import { mountBlock, nodesOf, press } from "../../test/react-native-stub";
import ApprovalsScreen from "../Approvals";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return {
    ...stub.reactNativeStub(),
    // Two gesture hosts with nothing to draw, which the kit blocks never use
    // and this SCREEN does.
    RefreshControl: () => null,
    Switch: (props: { accessibilityLabel?: string; value?: boolean }) =>
      React.createElement("input", {
        "aria-label": props.accessibilityLabel,
        type: "checkbox",
      }),
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
// The reconnection ceremony's browser half. Nothing in this file opens it —
// the row that would is asserted for its copy, not its side effect — but the
// module reaches expo's native core at import time.
vi.mock(
  import("expo-web-browser"),
  () =>
    ({
      openAuthSessionAsync: () => Promise.resolve({ type: "dismiss" }),
    }) as unknown as typeof import("expo-web-browser")
);
vi.mock(import("react-native-safe-area-context"), () => ({
  useSafeAreaInsets: () => ({ bottom: 34, left: 0, right: 0, top: 47 }),
}));

// Each mock takes the REAL function's signature, so a wire shape that drifts
// is a typecheck failure here rather than a test that passes against a module
// the app no longer has.
type Gateway = typeof import("../../lib/gateway");

const wire = vi.hoisted(() => ({
  approve: vi.fn<Gateway["decideNotificationsOutbox"]>(),
  confirmParked: vi.fn<Gateway["confirmParked"]>(),
  fetchJson: vi.fn<Gateway["fetchJson"]>(),
  resolveBase: vi.fn<Gateway["resolveGatewayBase"]>(),
  notifications: vi.fn<Gateway["getNotifications"]>(),
  scope: vi.fn<Gateway["decideNotificationsScope"]>(),
  updateNotice: vi.fn<Gateway["updateMobileNotice"]>(),
}));

vi.mock(
  import("../../lib/gateway"),
  () =>
    ({
      apiHeaders: () => ({}),
      beginNotificationsConnectionAuthorization: () =>
        Promise.resolve("https://accounts.example/authorize"),
      completeNotificationsConnectionAuthorization: () => Promise.resolve(),
      confirmParked: wire.confirmParked,
      decideNotificationsOutbox: wire.approve,
      decideNotificationsScope: wire.scope,
      fetchJson: wire.fetchJson,
      getNotifications: wire.notifications,
      requireGatewayBase: () => Promise.resolve("http://127.0.0.1:7777"),
      resolveGatewayBase: wire.resolveBase,
      subscribeMobileNotificationsChanges: () =>
        new Promise<void>(() => {
          // The doorbell never resolves; it is aborted on unmount.
        }),
      updateMobileNotice: wire.updateNotice,
    }) as unknown as Gateway
);
vi.mock(import("../../lib/notifications-core"), () => ({
  requestNotificationPermission: () => Promise.resolve(false),
}));
vi.mock(import("../../lib/replica/background-sync"), () => ({
  registerReplicaPushWake: () => Promise.resolve(),
}));

function outbox(over: Partial<MobileOutboxRow> = {}): MobileOutboxRow {
  return {
    actor: "the assistant",
    actorKind: "assistant",
    artifact: {
      body: "Tom — the survey arrived on Tuesday.",
      subject: "The survey came back",
      to: "tom@pemberton.example",
    },
    canEdit: true,
    connection: { kind: "gmail", label: "Gmail" },
    itemId: "o-1",
    stagedAt: "2026-08-13T08:41:00.000Z",
    target: "tom@pemberton.example",
    verb: "send_email",
    ...over,
  };
}

function payload(over: Partial<MobileNotifications> = {}): MobileNotifications {
  return {
    decisions: {
      count: 0,
      needsAuth: [],
      outbox: [],
      parked: [],
      scopeRequests: [],
      ...over.decisions,
    },
    notices: over.notices ?? [],
    unreadNoticeCount: 0,
  };
}

const navigation = {
  getParent: () => ({ navigate: vi.fn<(name: string) => void>() }),
  goBack: vi.fn<() => void>(),
  popTo: vi.fn<(name: string) => void>(),
} as unknown as SettingsScreenProps<"Approvals">["navigation"];

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
    <ApprovalsScreen
      navigation={navigation}
      route={
        {
          key: "approvals",
          name: "Approvals",
        } as SettingsScreenProps<"Approvals">["route"]
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
      (node) => (node.textContent ?? "") === label
    ) ?? null
  );
}

describe(ApprovalsScreen, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wire.resolveBase.mockResolvedValue("http://127.0.0.1:7777");
    wire.notifications.mockResolvedValue(payload());
    wire.fetchJson.mockResolvedValue({ grants: [] } as never);
    wire.approve.mockResolvedValue(undefined);
    wire.confirmParked.mockResolvedValue(undefined);
    wire.scope.mockResolvedValue(undefined);
    wire.updateNotice.mockResolvedValue(undefined);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("draws the row geometry while it reads, and says why", async () => {
    wire.notifications.mockReturnValue(
      new Promise<MobileNotifications>(() => {
        // Never settles: this is what "still reading" looks like.
      })
    );
    const container = await render();
    const skeleton = nodesOf(container, "div").find(
      (node) => node.dataset.role === "progressbar"
    );
    expect(skeleton?.getAttribute("aria-label")).toBe(
      "Reading what is waiting on you"
    );
    expect(textOf(container)).toContain(
      "A row knows its shape before its content arrives, so nothing reflows when it does."
    );
    expect(textOf(container)).toContain("Reading from the gateway");
    // Both bar verbs are withheld while loading.
    expect(buttonLabelled(container, "Review all")).toBeNull();
    expect(buttonLabelled(container, "History")).toBeNull();
  });

  it("says an empty consent surface is the healthy state, and still shows the record", async () => {
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("Nothing is waiting on you");
    expect(spans).toContain(
      "Staged writes, lapsed connections and access requests land here."
    );
    expect(spans).toContain("Nothing to attend to");
    // The reference tail renders in every state — a consent surface that hides
    // what it already consented to is not a record.
    expect(spans).toContain("Standing grants");
    expect(spans).toContain(
      "A standing grant skips this page for one narrow thing; revoking one takes effect on the next run."
    );
  });

  it("promotes the head of the queue to a quoted panel that says what approving does", async () => {
    wire.notifications.mockResolvedValue(
      payload({
        decisions: {
          count: 1,
          needsAuth: [],
          outbox: [outbox()],
          parked: [],
          scopeRequests: [],
        },
      })
    );
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("Waiting on you");
    expect(spans).toContain("The survey came back");
    expect(spans).toContain("Tom — the survey arrived on Tuesday.");
    expect(spans).toContain("nothing has been sent");
    expect(spans).toContain(
      "approving sends it immediately and cannot be undone"
    );
    // Deny is its own row, with the sentence about what a refusal means.
    expect(spans).toContain("Deny this write");
    expect(spans).toContain(
      "Nothing is sent. The automation is told it was refused, and remembers."
    );
    expect(spans).toContain(
      "1 item waiting on you · Nothing here has happened yet — approving is the act."
    );
  });

  it("approves, denies and edits through the real mutations", async () => {
    wire.notifications.mockResolvedValue(
      payload({
        decisions: {
          count: 1,
          needsAuth: [],
          outbox: [outbox()],
          parked: [],
          scopeRequests: [],
        },
      })
    );
    const container = await render();
    press(buttonLabelled(container, "Approve and send"));
    await settle();
    expect(wire.approve).toHaveBeenCalledWith("o-1", "approve", {
      alwaysAllow: false,
    });

    press(buttonLabelled(container, "Deny"));
    await settle();
    expect(wire.approve).toHaveBeenLastCalledWith("o-1", "discard");

    press(buttonLabelled(container, "Edit and approve"));
    await settle();
    expect(textOf(container)).toContain("Edit before sending");
    press(buttonLabelled(container, "Approve with edits"));
    await settle();
    const call = wire.approve.mock.calls.at(-1);
    expect(call?.[1]).toBe("approve");
    expect(call?.[2]?.artifact).toMatchObject({
      subject: "The survey came back",
    });
  });

  it("withdraws the verbs of a decision that is already in flight", async () => {
    wire.notifications.mockResolvedValue(
      payload({
        decisions: {
          count: 1,
          needsAuth: [],
          outbox: [outbox()],
          parked: [],
          scopeRequests: [],
        },
      })
    );
    wire.approve.mockReturnValue(
      new Promise<void>(() => {
        // Never settles: the write is in flight.
      })
    );
    const container = await render();
    press(buttonLabelled(container, "Approve and send"));
    await settle();
    expect(buttonLabelled(container, "Approve and send")).toBeNull();
    expect(buttonLabelled(container, "Deny")).toBeNull();
  });

  it("files everything else that is waiting as rows, and offers the chips only when the queue is long", async () => {
    wire.notifications.mockResolvedValue(
      payload({
        decisions: {
          count: 6,
          needsAuth: [
            {
              attentionAt: "2026-08-09T00:00:00.000Z",
              connectionId: "c-1",
              kind: "gmail",
              label: "Gmail",
              note: "The connection lapsed",
            },
          ],
          outbox: [
            outbox(),
            outbox({ itemId: "o-2", target: "ana@x.example" }),
          ],
          parked: [
            {
              caller: "Tidy downloads",
              callerKind: "agent",
              command: "delete_files",
              input: { older_than: "1y" },
              invocationId: "i-1",
              parkedAt: "2026-08-13T08:00:00.000Z",
            },
          ],
          scopeRequests: [
            {
              appId: "Weekly digest",
              plane: "app",
              purpose: "read your calendar",
              requestId: "r-1",
              requestedAt: "2026-08-12T08:00:00.000Z",
              scopes: [{ schema: "calendar", table: "events", verbs: "read" }],
            },
          ],
        },
      })
    );
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("Also waiting");
    expect(spans).toContain("Gmail");
    expect(spans).toContain("Lapsed");
    expect(spans).toContain("delete_files");
    expect(spans).toContain("Weekly digest is asking for wider access");
    // Five waiting items is past the chip threshold.
    expect(spans).toContain("Everything");
    expect(spans).toContain("High risk");

    // A parked act opens in place and shows WHAT was asked before deciding.
    // The queue's Reviews are, in order: the second staged write, the parked
    // act, then the scope request.
    press(
      nodesOf(container, "button").filter(
        (node) => (node.textContent ?? "") === "Review"
      )[1]
    );
    await settle();
    expect(textOf(container).join(" ")).toContain("older_than");
    press(buttonLabelled(container, "Approve"));
    await settle();
    expect(wire.confirmParked).toHaveBeenCalledWith("i-1", true);
  });

  it("lists standing grants and revokes one against the gateway", async () => {
    wire.fetchJson.mockResolvedValue({
      grants: [
        {
          actor: "Photos",
          actorId: "app:photos",
          createdAt: "2026-08-13T08:00:00.000Z",
          grantId: "g-1",
          revokedAt: null,
          target: "ana@pemberton.example",
          verb: "share",
        },
      ],
    } as never);
    const container = await render();
    expect(textOf(container)).toContain("Photos may always share");
    press(buttonLabelled(container, "Revoke"));
    await settle();
    // The revoke, then the re-read behind it — the row is the gateway's to
    // report, so the screen never patches it away locally.
    const deletes = wire.fetchJson.mock.calls.filter(
      (call) => call[1]?.method === "DELETE"
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.[0]).toContain("/centraid/_vault/outbox-grants/g-1");
  });

  it("treats an unpaired phone as the error state, with the one way forward", async () => {
    wire.resolveBase.mockResolvedValue(undefined);
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("Could not reach the consent store");
    expect(spans).toContain(
      "The gateway answered; the queue that holds staged writes did not."
    );
    expect(spans).toContain("This phone is not paired with a gateway yet.");
    expect(spans).toContain("This page could not load");
    press(buttonLabelled(container, "Open Settings"));
    expect(navigation.popTo).toHaveBeenCalledWith("SettingsHome");
    // The filled commit is withheld on error; the quiet verb is not.
    expect(buttonLabelled(container, "Review all")).toBeNull();
    expect(buttonLabelled(container, "History")).not.toBeNull();
  });
});
