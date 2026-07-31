// governance: allow-repo-hygiene file-size-limit (#552) one suite per screen — decision/risk/actor/grant/collapse/filter/expand cases all exercise the single ApprovalsScreen activity contract and share its mount fixtures
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import ApprovalsScreen, {
  NOTICE_BAR_MAX,
  noticeBarCount,
  noticeHue,
  noticeSeverityLabel,
  noticeSpanPhrase,
} from "./ApprovalsScreen.js";
import type {
  ApprovalsActivityRowDTO,
  ApprovalsGrantRowDTO,
  ApprovalsNeedsAuthRowDTO,
  ApprovalsOutboxRowDTO,
  ApprovalsParkedRowDTO,
  ApprovalsScopeRequestRowDTO,
  ApprovalsScreenProps,
  InboxNoticeRowDTO,
} from "./ApprovalsScreen.js";

const outboxRow: ApprovalsOutboxRowDTO = {
  itemId: "item1",
  connectionLabel: "personal",
  connectionKind: "pull.gmail",
  verb: "gmail.send",
  target: "ravi@example.com",
  recipient: "ravi@example.com",
  subject: "Hi",
  bodyPreview: "See you at 6.",
  fields: [
    { key: "to", label: "To", value: "ravi@example.com" },
    { key: "subject", label: "Subject", value: "Hi" },
    { key: "body", label: "Body", value: "See you at 6." },
  ],
  stagedAgo: "5m ago",
  note: null,
  canEdit: false,
  artifact: { to: "ravi@example.com", subject: "Hi", body: "See you at 6." },
  caller: "gmail-send",
  callerKind: "agent",
};

const editableOutboxRow: ApprovalsOutboxRowDTO = {
  ...outboxRow,
  canEdit: true,
  fields: [
    { key: "to", label: "To", value: "ravi@example.com, asha@example.com" },
    { key: "subject", label: "Subject", value: "Hi" },
    { key: "body", label: "Body", value: "See you at 6." },
  ],
  artifact: {
    to: ["ravi@example.com", "asha@example.com"],
    subject: "Hi",
    body: "See you at 6.",
  },
};

const needsAuthRow: ApprovalsNeedsAuthRowDTO = {
  connectionId: "c1",
  label: "work gmail",
  kind: "pull.gmail",
  note: "token expired",
};

const parkedRow: ApprovalsParkedRowDTO = {
  invocationId: "inv1",
  command: "social.send_message",
  caller: "Briefing",
  callerKind: "app",
  parkedAgo: "2m ago",
  inputPreview: '{\n  "to": "x"\n}',
};

const scopeRow: ApprovalsScopeRequestRowDTO = {
  requestId: "r1",
  appId: "invoicer",
  purpose: "dpv:ServiceProvision",
  scopeSummary: "business.invoice (act)",
  requestedAgo: "1h ago",
};

const grantRow: ApprovalsGrantRowDTO = {
  grantId: "g1",
  actorLabel: "gmail-send",
  verb: "gmail.send",
  target: "ravi@example.com",
  createdAgo: "3d ago",
};

function noticeRow(over: Partial<InboxNoticeRowDTO> = {}): InboxNoticeRowDTO {
  return {
    noticeId: "notice-1",
    kind: "automation",
    sourceRef: "brief/digest",
    headline: "Digest failed",
    detail: { sourceType: "automation" },
    detailText: "Three messages were not imported.",
    sourceLabel: "brief/digest",
    severity: "high",
    sourceType: "automation",
    count: 2,
    firstAt: "2026-07-29T01:00:00.000Z",
    lastAt: "2026-07-30T01:00:00.000Z",
    readAt: null,
    archivedAt: null,
    ...over,
  };
}

function activityRow(
  over: Partial<ApprovalsActivityRowDTO> = {}
): ApprovalsActivityRowDTO {
  return {
    receiptId: "receipt-1",
    label: "Sync remove connection",
    detail: "agent.command · cmd-abc…",
    objectId: "cmd-abc123def456",
    objectType: "agent.command",
    occurredAgo: "12m ago",
    occurredAt: "2026-03-01T12:00:00.000Z",
    decision: "allow",
    risk: null,
    actor: "gmail-send",
    actorKind: "agent",
    grantId: null,
    attribution: "owner",
    count: 1,
    action: "act sync.remove_connection",
    ...over,
  };
}

const fillActivity = activityRow({
  receiptId: "receipt-fill",
  label: "Locker filled a login",
  detail: "https://example.test",
  objectId: "login-1",
  objectType: "locker.item",
  occurredAgo: "1m ago",
  decision: "allow",
  actor: null,
  actorKind: null,
  attribution: "owner",
  action: "reveal",
});

function makeProps(
  over: Partial<ApprovalsScreenProps> = {}
): ApprovalsScreenProps {
  return {
    outbox: [],
    needsAuth: [],
    parked: [],
    scopeRequests: [],
    grants: [],
    activity: [],
    busyId: null,
    onApproveOutbox: vi.fn<ApprovalsScreenProps["onApproveOutbox"]>(),
    onDenyOutbox: vi.fn<ApprovalsScreenProps["onDenyOutbox"]>(),
    onOpenSettings: vi.fn<ApprovalsScreenProps["onOpenSettings"]>(),
    onConfirmParked: vi.fn<ApprovalsScreenProps["onConfirmParked"]>(),
    onDecideScopeRequest: vi.fn<ApprovalsScreenProps["onDecideScopeRequest"]>(),
    onRevokeGrant: vi.fn<ApprovalsScreenProps["onRevokeGrant"]>(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe("screens/ApprovalsScreen", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });
  function mount(props: ApprovalsScreenProps): HTMLDivElement {
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container as HTMLDivElement);
      root.render(<ApprovalsScreen {...props} />);
    });
    return container;
  }
  function findButton(el: HTMLElement, text: string): HTMLButtonElement {
    const btn = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(text)
    );
    if (!btn) throw new Error(`no button with text "${text}"`);
    return btn as HTMLButtonElement;
  }
  function rerender(props: ApprovalsScreenProps): void {
    act(() => {
      root?.render(<ApprovalsScreen {...props} />);
    });
  }
  function openArchived(el: HTMLElement): void {
    act(() => {
      findButton(el, "Archived").click();
    });
  }

  describe(ApprovalsScreen, () => {
    it("shows the honest empty state and keeps retained grants under Archived", () => {
      const el = mount(makeProps());
      expect(el.textContent).toContain("Nothing waiting on you.");
      openArchived(el);
      expect(el.textContent).toContain("Standing grants");
      expect(el.textContent).toContain("No standing grants yet");
    });

    it("renders every decision type in one pinned Needs me stream", () => {
      const el = mount(
        makeProps({
          outbox: [outboxRow],
          needsAuth: [needsAuthRow],
          parked: [parkedRow],
          scopeRequests: [scopeRow],
        })
      );
      expect(el.textContent).toContain("Hi");
      expect(el.textContent).toContain("work gmail");
      expect(el.textContent).toContain("social.send_message");
      expect(el.textContent).toContain("invoicer");
      expect(el.querySelectorAll("section")).toHaveLength(1);
      expect(el.textContent).toContain("4 waiting on you");
    });

    it("keeps notices non-blocking while exposing read and archive actions", () => {
      const onReadNotice =
        vi.fn<NonNullable<ApprovalsScreenProps["onReadNotice"]>>();
      const onArchiveNotice =
        vi.fn<NonNullable<ApprovalsScreenProps["onArchiveNotice"]>>();
      const el = mount(
        makeProps({
          outbox: [outboxRow],
          notices: [noticeRow()],
          onReadNotice,
          onArchiveNotice,
        })
      );
      expect(el.textContent).toContain("1 waiting on you");
      expect(el.textContent).toContain("Digest failed");
      // The collapsed multiplicity now rides the meta line as a duration
      // phrase + attempt strip, not a `×N` suffix on the headline.
      expect(el.textContent).toContain("failing for 1 day");
      expect(
        el.querySelector('[data-testid="notice-severity-pill"]')?.textContent
      ).toBe("Failed");
      expect(
        el.querySelectorAll('[data-testid="notice-streak"] span span')
      ).toHaveLength(2);
      expect(el.querySelector('[data-testid="notice-tile"]')).not.toBeNull();
      expect(
        el.querySelector('[data-testid="notice-unread-dot"]')
      ).not.toBeNull();
      expect(el.textContent).toContain("brief/digest");
      act(() => findButton(el, "Mark read").click());
      act(() => {
        (
          [...el.querySelectorAll("button")].find(
            (button) => button.textContent === "Archive"
          ) as HTMLButtonElement
        ).click();
      });
      expect(onReadNotice).toHaveBeenCalledWith("notice-1");
      expect(onArchiveNotice).toHaveBeenCalledWith("notice-1");
    });

    it("filters active notices by source and retains archived notices in history", () => {
      const el = mount(
        makeProps({
          notices: [
            noticeRow(),
            noticeRow({
              noticeId: "app-notice",
              sourceRef: "app-1",
              headline: "Export sent",
              sourceType: "app",
              detail: { sourceType: "app" },
              sourceLabel: "Exports",
            }),
            noticeRow({
              noticeId: "archived-notice",
              sourceRef: "old",
              headline: "Old failure",
              archivedAt: "2026-07-30T02:00:00.000Z",
            }),
          ],
        })
      );
      act(() => findButton(el, "Automations").click());
      expect(el.textContent).toContain("Digest failed");
      expect(el.textContent).not.toContain("Export sent");
      expect(el.textContent).not.toContain("Old failure");
      openArchived(el);
      expect(el.textContent).toContain("Old failure");
      expect(el.textContent).not.toContain("Digest failed");
    });

    it("keeps open decisions pinned under every chip, including Archived", () => {
      // The chips filter the NOTICE stream. A decision that is blocking the
      // owner must not disappear because they tapped "Apps" (#647 D3).
      const el = mount(
        makeProps({
          outbox: [outboxRow],
          parked: [parkedRow],
          notices: [noticeRow()],
        })
      );
      for (const chip of ["Automations", "Agents", "Apps", "Archived"]) {
        act(() => findButton(el, chip).click());
        expect(el.textContent).toContain("Hi");
        expect(el.textContent).toContain("social.send_message");
        expect(el.textContent).toContain("2 waiting on you");
      }
    });

    it("says only that a notice filter is empty, never that the inbox is clear", () => {
      const el = mount(makeProps({ outbox: [outboxRow], notices: [] }));
      act(() => findButton(el, "Apps").click());
      expect(el.textContent).toContain("No notices here.");
      expect(el.textContent).not.toContain("Nothing waiting on you.");
      expect(el.textContent).toContain("Hi");
    });

    it("focuses the outbox decision an outbox notice deep-links to", () => {
      const props = makeProps({ outbox: [outboxRow] });
      const el = mount(props);
      openArchived(el);
      rerender({ ...props, focusOutbox: { itemId: "item1", nonce: 1 } });

      expect(findButton(el, "Needs me").dataset.active).toBe("true");
      expect(findButton(el, "Archived").dataset.active).toBeUndefined();
      expect(
        (
          el.querySelector(
            '[data-testid="outbox-row-item1"]'
          ) as HTMLElement | null
        )?.dataset.focused
      ).toBe("true");
      // Expanded, so the owner lands on the artifact rather than a collapsed row.
      expect(el.textContent).toContain("See you at 6.");
    });

    it("falls back to Needs me with nothing focused when the item is gone", () => {
      const props = makeProps({ outbox: [outboxRow] });
      const el = mount(props);
      openArchived(el);
      rerender({ ...props, focusOutbox: { itemId: "decided", nonce: 1 } });

      expect(findButton(el, "Needs me").dataset.active).toBe("true");
      expect(el.querySelector('[data-focused="true"]')).toBeNull();
    });

    it("expands an outbox row on click to reveal the readable artifact fields + actions", () => {
      const el = mount(makeProps({ outbox: [outboxRow] }));
      expect(el.textContent).not.toContain("See you at 6.");
      act(() => {
        findButton(el, "Hi").click();
      });
      expect(el.textContent).toContain("See you at 6.");
      expect(el.querySelector(".editNote")?.textContent).toContain(
        "can’t be edited yet"
      );
    });

    it("fires onApproveOutbox with the always-allow checkbox state", () => {
      const onApproveOutbox = vi.fn<ApprovalsScreenProps["onApproveOutbox"]>();
      const el = mount(makeProps({ outbox: [outboxRow], onApproveOutbox }));
      act(() => {
        findButton(el, "Hi").click();
      });
      const checkbox = el.querySelector(
        'input[type="checkbox"]'
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });
      act(() => {
        findButton(el, "Approve").click();
      });
      expect(onApproveOutbox).toHaveBeenCalledWith("item1", true);
    });

    it("fires onDenyOutbox for the expanded item", () => {
      const onDenyOutbox = vi.fn<ApprovalsScreenProps["onDenyOutbox"]>();
      const el = mount(makeProps({ outbox: [outboxRow], onDenyOutbox }));
      act(() => {
        findButton(el, "Hi").click();
      });
      act(() => {
        findButton(el, "Deny").click();
      });
      expect(onDenyOutbox).toHaveBeenCalledWith("item1");
    });

    it("shows an Automation badge and the display name for an agent-kind outbox caller", () => {
      const el = mount(makeProps({ outbox: [outboxRow] }));
      expect(el.textContent).toContain("Automation");
      expect(el.textContent).toContain("gmail-send");
    });

    it("shows an Assistant badge for an assistant-kind outbox caller", () => {
      const el = mount(
        makeProps({
          outbox: [
            { ...outboxRow, caller: "Assistant", callerKind: "assistant" },
          ],
        })
      );
      expect(el.textContent).toContain("Assistant");
    });

    it("shows an App badge for an app-kind outbox caller", () => {
      const el = mount(
        makeProps({
          outbox: [{ ...outboxRow, caller: "Briefing", callerKind: "app" }],
        })
      );
      expect(el.textContent).toContain("App");
      expect(el.textContent).toContain("Briefing");
    });

    it("shows no kind badge for an owner-staged outbox item, but still shows the caller name", () => {
      const el = mount(
        makeProps({
          outbox: [{ ...outboxRow, caller: "owner", callerKind: "owner" }],
        })
      );
      expect(el.querySelector("[data-kind]")).toBeNull();
      expect(el.textContent).toContain("owner");
    });

    it("routes needs-auth reconnection through onOpenSettings", () => {
      const onOpenSettings = vi.fn<ApprovalsScreenProps["onOpenSettings"]>();
      const el = mount(
        makeProps({ needsAuth: [needsAuthRow], onOpenSettings })
      );
      act(() => {
        findButton(el, "Reconnect").click();
      });
      expect(onOpenSettings).toHaveBeenCalledWith(
        expect.objectContaining({ type: "click" })
      );
    });

    it("fires onConfirmParked(true) on Approve without needing to expand first", () => {
      const onConfirmParked = vi.fn<ApprovalsScreenProps["onConfirmParked"]>();
      const el = mount(makeProps({ parked: [parkedRow], onConfirmParked }));
      act(() => {
        findButton(el, "social.send_message").click();
      });
      act(() => {
        findButton(el, "Approve").click();
      });
      expect(onConfirmParked).toHaveBeenCalledWith("inv1", true);
    });

    it("shows an App badge and the display name for an app-kind parked caller", () => {
      const el = mount(makeProps({ parked: [parkedRow] }));
      expect(el.textContent).toContain("App");
      expect(el.textContent).toContain("Briefing");
    });

    it("shows an Automation badge for an agent-kind parked caller (automations ride the agent plane)", () => {
      const el = mount(
        makeProps({
          parked: [
            {
              ...parkedRow,
              caller: "E2e Agent Purge Demo",
              callerKind: "agent",
            },
          ],
        })
      );
      expect(el.textContent).toContain("Automation");
      expect(el.textContent).toContain("E2e Agent Purge Demo");
    });

    it("shows an Assistant badge for an assistant-kind parked caller, distinct from an automation", () => {
      const el = mount(
        makeProps({
          parked: [
            { ...parkedRow, caller: "Assistant", callerKind: "assistant" },
          ],
        })
      );
      expect(el.textContent).toContain("Assistant");
      expect(el.querySelector('[data-kind="automation"]')).toBeNull();
    });

    it("fires onDecideScopeRequest inline (no expansion needed)", () => {
      const onDecideScopeRequest =
        vi.fn<ApprovalsScreenProps["onDecideScopeRequest"]>();
      const el = mount(
        makeProps({ scopeRequests: [scopeRow], onDecideScopeRequest })
      );
      act(() => {
        findButton(el, "Deny").click();
      });
      expect(onDecideScopeRequest).toHaveBeenCalledWith("r1", false);
    });

    it("renders standing grants with a Revoke action", () => {
      const onRevokeGrant = vi.fn<ApprovalsScreenProps["onRevokeGrant"]>();
      const el = mount(makeProps({ grants: [grantRow], onRevokeGrant }));
      openArchived(el);
      expect(el.textContent).toContain("gmail-send");
      expect(el.textContent).toContain("ravi@example.com");
      act(() => {
        findButton(el, "Revoke").click();
      });
      expect(onRevokeGrant).toHaveBeenCalledWith("g1");
    });

    it("shows the origin of a recent Locker fill in review activity", () => {
      const el = mount(makeProps({ activity: [fillActivity] }));
      openArchived(el);
      expect(el.textContent).toContain("Recent activity");
      expect(el.textContent).toContain("Locker filled a login");
      expect(el.textContent).toContain("https://example.test");
    });

    it("renders a distinct decision badge + icon accent per decision value", () => {
      const el = mount(
        makeProps({
          activity: [
            activityRow({
              receiptId: "a1",
              decision: "allow",
              label: "Allowed act",
            }),
            activityRow({
              receiptId: "a2",
              decision: "deny",
              label: "Denied act",
            }),
          ],
        })
      );
      openArchived(el);
      const badges = [
        ...el.querySelectorAll('[data-testid="activity-decision-badge"]'),
      ].map((n) => n.textContent);
      expect(badges).toStrictEqual(
        expect.arrayContaining(["Allowed", "Denied"])
      );
      const allowRow = el.querySelector('[data-decision="allow"]');
      const denyRow = el.querySelector('[data-decision="deny"]');
      expect(allowRow).not.toBeNull();
      expect(denyRow).not.toBeNull();
      expect(allowRow?.className).not.toBe(denyRow?.className);
      expect(
        allowRow?.querySelector('[data-testid="activity-decision-icon"]')
      ).not.toBeNull();
      expect(
        denyRow?.querySelector('[data-testid="activity-decision-icon"]')
      ).not.toBeNull();
    });

    it("shows a risk salience marker only when risk is non-null", () => {
      const el = mount(
        makeProps({
          activity: [
            activityRow({ receiptId: "r1", risk: "high", label: "Risky" }),
            activityRow({ receiptId: "r2", risk: null, label: "Quiet" }),
          ],
        })
      );
      openArchived(el);
      expect(
        el.querySelectorAll('[data-testid="activity-risk-marker"]')
      ).toHaveLength(1);
      expect(el.querySelector('[data-risk="high"]')).not.toBeNull();
    });

    it("shows an actor KindBadge matching Outbox treatment per actorKind", () => {
      const el = mount(
        makeProps({
          activity: [
            activityRow({
              receiptId: "app1",
              actor: "Briefing",
              actorKind: "app",
              label: "App act",
            }),
            activityRow({
              receiptId: "ag1",
              actor: "gmail-send",
              actorKind: "agent",
              label: "Agent act",
            }),
            activityRow({
              receiptId: "as1",
              actor: "Assistant",
              actorKind: "assistant",
              label: "Assistant act",
            }),
          ],
        })
      );
      openArchived(el);
      expect(el.textContent).toContain("App");
      expect(el.textContent).toContain("Briefing");
      expect(el.textContent).toContain("Automation");
      expect(el.textContent).toContain("gmail-send");
      expect(el.textContent).toContain("Assistant");
    });

    it("attributes standing-grant auto-allow and fires onRevokeGrant from the activity row", () => {
      const onRevokeGrant = vi.fn<ApprovalsScreenProps["onRevokeGrant"]>();
      const el = mount(
        makeProps({
          activity: [
            activityRow({
              receiptId: "g-row",
              grantId: "grant-42",
              attribution: "grant",
              decision: "allow",
              label: "Auto send",
            }),
          ],
          onRevokeGrant,
        })
      );
      openArchived(el);
      expect(
        el.querySelector('[data-testid="activity-attribution-grant"]')
          ?.textContent
      ).toContain("Auto-allowed by standing grant");
      act(() => {
        findButton(el, "Auto send").click();
      });
      act(() => {
        findButton(el, "Revoke grant").click();
      });
      expect(onRevokeGrant).toHaveBeenCalledWith("grant-42");
    });

    it("says approved-by-the-owner when attribution is owner", () => {
      const el = mount(
        makeProps({
          activity: [
            activityRow({
              attribution: "owner",
              decision: "allow",
              label: "Owner ok",
            }),
          ],
        })
      );
      openArchived(el);
      expect(
        el.querySelector('[data-testid="activity-attribution-owner"]')
          ?.textContent
      ).toContain("Approved by the owner");
    });

    it("shows a ×N marker for collapsed adjacent duplicates", () => {
      const el = mount(
        makeProps({
          activity: [
            activityRow({
              count: 3,
              label: "Draft drop",
              receiptId: "collapsed",
            }),
          ],
        })
      );
      openArchived(el);
      expect(
        el.querySelector('[data-testid="activity-count"]')?.textContent
      ).toBe("×3");
    });

    it("expands an activity row to the full object id and absolute time", () => {
      const el = mount(
        makeProps({
          activity: [
            activityRow({
              label: "Remove connection",
              objectId: "cmd-abc123def456",
              objectType: "agent.command",
              occurredAt: "2026-03-01T12:00:00.000Z",
            }),
          ],
        })
      );
      openArchived(el);
      expect(el.querySelector('[data-testid="activity-detail"]')).toBeNull();
      act(() => {
        findButton(el, "Remove connection").click();
      });
      const detail = el.querySelector('[data-testid="activity-detail"]');
      expect(detail).not.toBeNull();
      expect(detail?.textContent).toContain("cmd-abc123def456");
      expect(detail?.textContent).toContain("agent.command");
      // Absolute timestamp is reachable in the expanded panel.
      expect(detail?.textContent).toMatch(/2026|Mar|03/u);
    });

    it("filters to Denied-only when the Denied chip is active", () => {
      const el = mount(
        makeProps({
          activity: [
            activityRow({
              receiptId: "ok",
              decision: "allow",
              label: "Allowed row",
            }),
            activityRow({
              receiptId: "no",
              decision: "deny",
              label: "Denied row",
            }),
          ],
        })
      );
      openArchived(el);
      expect(el.textContent).toContain("Allowed row");
      expect(el.textContent).toContain("Denied row");
      act(() => {
        (
          el.querySelector(
            '[data-testid="activity-filter-denied"]'
          ) as HTMLButtonElement
        ).click();
      });
      expect(el.textContent).not.toContain("Allowed row");
      expect(el.textContent).toContain("Denied row");
    });

    it("shows See all when the feed is truncated and fires onSeeAllActivity", () => {
      const onSeeAllActivity =
        vi.fn<NonNullable<ApprovalsScreenProps["onSeeAllActivity"]>>();
      const el = mount(
        makeProps({
          activity: [activityRow()],
          activityTruncated: true,
          onSeeAllActivity,
        })
      );
      openArchived(el);
      expect(
        el.querySelector('[data-testid="activity-see-all"]')
      ).not.toBeNull();
      act(() => {
        findButton(el, "See all").click();
      });
      expect(onSeeAllActivity).toHaveBeenCalledWith(
        expect.objectContaining({ type: "click" })
      );
    });

    it("does not show See all when the feed is not truncated", () => {
      const el = mount(
        makeProps({ activity: [activityRow()], activityTruncated: false })
      );
      openArchived(el);
      expect(el.querySelector('[data-testid="activity-see-all"]')).toBeNull();
    });

    it("shows an Edit affordance only when canEdit is true, and keeps the honest copy otherwise", () => {
      const notEditable = mount(makeProps({ outbox: [outboxRow] }));
      act(() => {
        findButton(notEditable, "Hi").click();
      });
      expect(() => findButton(notEditable, "Edit")).toThrow(Error);
      expect(notEditable.querySelector(".editNote")?.textContent).toContain(
        "can’t be edited yet"
      );

      const editable = mount(makeProps({ outbox: [editableOutboxRow] }));
      act(() => {
        findButton(editable, "Hi").click();
      });
      expect(() => findButton(editable, "Edit")).not.toThrow();
      expect(editable.querySelector(".editNote")).toBeNull();
    });

    it("edit mode turns string fields into inputs/textarea and the string[] field into a comma input, seeded with the staged values", () => {
      const el = mount(makeProps({ outbox: [editableOutboxRow] }));
      act(() => {
        findButton(el, "Hi").click();
      });
      act(() => {
        findButton(el, "Edit").click();
      });
      const toInput = el.querySelector(
        'input[aria-label="To"]'
      ) as HTMLInputElement;
      const subjectInput = el.querySelector(
        'input[aria-label="Subject"]'
      ) as HTMLInputElement;
      const bodyArea = el.querySelector(
        'textarea[aria-label="Body"]'
      ) as HTMLTextAreaElement;
      expect(toInput.value).toBe("ravi@example.com, asha@example.com");
      expect(subjectInput.value).toBe("Hi");
      expect(bodyArea.value).toBe("See you at 6.");
      // Cancel and Approve with edits replace Edit/Approve while editing.
      expect(() => findButton(el, "Cancel")).not.toThrow();
      expect(() => findButton(el, "Approve with edits")).not.toThrow();
    });

    it('submits the edited artifact on "Approve with edits", splitting the recipients on comma', () => {
      const onApproveOutbox = vi.fn<ApprovalsScreenProps["onApproveOutbox"]>();
      const el = mount(
        makeProps({ outbox: [editableOutboxRow], onApproveOutbox })
      );
      act(() => {
        findButton(el, "Hi").click();
      });
      act(() => {
        findButton(el, "Edit").click();
      });
      const setNativeValue = (
        input: HTMLInputElement | HTMLTextAreaElement,
        value: string
      ): void => {
        const proto =
          input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      act(() => {
        setNativeValue(
          el.querySelector('input[aria-label="Subject"]') as HTMLInputElement,
          "New subject"
        );
        setNativeValue(
          el.querySelector(
            'textarea[aria-label="Body"]'
          ) as HTMLTextAreaElement,
          "New body."
        );
        setNativeValue(
          el.querySelector('input[aria-label="To"]') as HTMLInputElement,
          "x@example.com, y@example.com"
        );
      });
      act(() => {
        findButton(el, "Approve with edits").click();
      });
      expect(onApproveOutbox).toHaveBeenCalledWith("item1", false, {
        to: ["x@example.com", "y@example.com"],
        subject: "New subject",
        body: "New body.",
      });
    });

    it("Cancel exits edit mode and restores the read-only fields, without approving", () => {
      const onApproveOutbox = vi.fn<ApprovalsScreenProps["onApproveOutbox"]>();
      const el = mount(
        makeProps({ outbox: [editableOutboxRow], onApproveOutbox })
      );
      act(() => {
        findButton(el, "Hi").click();
      });
      act(() => {
        findButton(el, "Edit").click();
      });
      act(() => {
        findButton(el, "Cancel").click();
      });
      expect(el.querySelector('input[aria-label="Subject"]')).toBeNull();
      expect(el.textContent).toContain("See you at 6.");
      expect(onApproveOutbox).not.toHaveBeenCalled();
    });

    it("a plain Approve with no edits calls onApproveOutbox with just (itemId, alwaysAllow)", () => {
      const onApproveOutbox = vi.fn<ApprovalsScreenProps["onApproveOutbox"]>();
      const el = mount(makeProps({ outbox: [outboxRow], onApproveOutbox }));
      act(() => {
        findButton(el, "Hi").click();
      });
      act(() => {
        findButton(el, "Approve").click();
      });
      expect(onApproveOutbox).toHaveBeenCalledWith("item1", false);
    });

    it("disables the busy row’s actions", () => {
      const el = mount(makeProps({ outbox: [outboxRow], busyId: "item1" }));
      act(() => {
        findButton(el, "Hi").click();
      });
      expect(findButton(el, "Approve").disabled).toBe(true);
      expect(findButton(el, "Deny").disabled).toBe(true);
    });
  });
});

describe("notice presentation helpers", () => {
  const HUES = [
    "amber",
    "forest",
    "indigo",
    "ochre",
    "rose",
    "slate",
    "teal",
    "violet",
  ];

  it("hashes a correspondent to a stable palette hue", () => {
    expect(noticeHue("brief/digest")).toBe(noticeHue("brief/digest"));
    expect(HUES).toContain(noticeHue("brief/digest"));
    expect(HUES).toContain(noticeHue(""));
    // Different correspondents should not all collapse onto one hue.
    const spread = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => noticeHue(s))
    );
    expect(spread.size).toBeGreaterThan(1);
  });

  it("labels only warning and high severities", () => {
    expect(noticeSeverityLabel("automation", "info")).toBeNull();
    expect(noticeSeverityLabel("automation", "high")).toBe("Failed");
    expect(noticeSeverityLabel("automation", "warning")).toBe("Warning");
    expect(noticeSeverityLabel("gateway-health", "high")).toBe("Down");
    expect(noticeSeverityLabel("gateway-health", "warning")).toBe("Degraded");
  });

  it("phrases a collapsed span as a failure duration or a neutral count", () => {
    const at = (iso: string): string => iso;
    expect(
      noticeSpanPhrase({
        count: 1,
        firstAt: at("2026-07-01T00:00:00.000Z"),
        lastAt: at("2026-07-07T00:00:00.000Z"),
        severity: "high",
      })
    ).toBeNull();
    expect(
      noticeSpanPhrase({
        count: 6,
        firstAt: at("2026-07-01T00:00:00.000Z"),
        lastAt: at("2026-07-07T00:00:00.000Z"),
        severity: "high",
      })
    ).toBe("failing for 6 days");
    expect(
      noticeSpanPhrase({
        count: 6,
        firstAt: at("2026-07-01T00:00:00.000Z"),
        lastAt: at("2026-07-01T03:00:00.000Z"),
        severity: "high",
      })
    ).toBe("×6 over 3 hours");
    // Informational notices never claim to be "failing", however long the run.
    expect(
      noticeSpanPhrase({
        count: 6,
        firstAt: at("2026-07-01T00:00:00.000Z"),
        lastAt: at("2026-07-07T00:00:00.000Z"),
        severity: "info",
      })
    ).toBe("×6 over 6 days");
    // Unparseable / non-advancing timestamps state multiplicity only.
    expect(
      noticeSpanPhrase({
        count: 3,
        firstAt: "nope",
        lastAt: "nope",
        severity: "high",
      })
    ).toBe("×3");
    expect(
      noticeSpanPhrase({
        count: 3,
        firstAt: at("2026-07-01T00:00:00.000Z"),
        lastAt: at("2026-07-01T00:00:00.000Z"),
        severity: "high",
      })
    ).toBe("×3");
  });

  it("clamps the attempt strip and leaves the remainder to a +N label", () => {
    expect(noticeBarCount(0)).toBe(0);
    expect(noticeBarCount(1)).toBe(0);
    expect(noticeBarCount(3)).toBe(3);
    expect(noticeBarCount(NOTICE_BAR_MAX)).toBe(NOTICE_BAR_MAX);
    expect(noticeBarCount(40)).toBe(NOTICE_BAR_MAX);
    expect(noticeBarCount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
