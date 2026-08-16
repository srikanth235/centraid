// governance: allow-repo-hygiene file-size-limit (#765) one suite per screen — staged write, waiting queue, grants, ledger, history and the five states all exercise the single ApprovalsScreen contract and share its mount fixtures
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import ApprovalsScreen, {
  callerPhrase,
  mergeRevokedHolders,
  noticeSeverityLabel,
  noticeSpanPhrase,
  outboundLabel,
  revokedHolderKey,
} from "./ApprovalsScreen.js";
import type {
  ApprovalsActivityRowDTO,
  ApprovalsGrantRowDTO,
  ApprovalsNeedsAuthRowDTO,
  ApprovalsOutboxRowDTO,
  ApprovalsParkedRowDTO,
  ApprovalsScopeRequestRowDTO,
  ApprovalsScreenProps,
  NoticeRowDTO,
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

function noticeRow(over: Partial<NoticeRowDTO> = {}): NoticeRowDTO {
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
    storeGrants: [],
    activity: [],
    busyId: null,
    onApproveOutbox: vi.fn<ApprovalsScreenProps["onApproveOutbox"]>(),
    onDenyOutbox: vi.fn<ApprovalsScreenProps["onDenyOutbox"]>(),
    onOpenSettings: vi.fn<ApprovalsScreenProps["onOpenSettings"]>(),
    onConfirmParked: vi.fn<ApprovalsScreenProps["onConfirmParked"]>(),
    onDecideScopeRequest: vi.fn<ApprovalsScreenProps["onDecideScopeRequest"]>(),
    onRevokeGrant: vi.fn<ApprovalsScreenProps["onRevokeGrant"]>(),
    onRevokeStoreGrant: vi.fn<ApprovalsScreenProps["onRevokeStoreGrant"]>(),
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
  function rerender(props: ApprovalsScreenProps): void {
    act(() => {
      root?.render(<ApprovalsScreen {...props} />);
    });
  }
  /** Buttons carry their whole label as text, so an EXACT match is the honest
   *  selector: "Deny" and "Deny this write" are two different controls. */
  function findButton(el: HTMLElement, text: string): HTMLButtonElement {
    const btn = [...el.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text
    );
    if (!btn) throw new Error(`no button labelled "${text}"`);
    return btn as HTMLButtonElement;
  }
  function click(el: HTMLElement, text: string): void {
    act(() => findButton(el, text).click());
  }
  function sectionMeta(el: HTMLElement, label: string): string | undefined {
    const head = [...el.querySelectorAll("h2")].find(
      (h) => h.textContent === label
    );
    return head?.nextElementSibling?.textContent ?? undefined;
  }

  describe(ApprovalsScreen, () => {
    it("says empty is the healthy state, and still keeps the standing grants reachable", () => {
      const el = mount(makeProps());
      expect(el.textContent).toContain("Nothing is waiting on you");
      expect(el.textContent).toContain(
        "Staged writes, lapsed connections and access requests land here."
      );
      // The empty state's one verb has somewhere real to land: the grants
      // section renders in every state, because a consent surface that hides
      // what it already consented to is not a record.
      expect(() => findButton(el, "Review standing grants")).not.toThrow();
      expect(el.textContent).toContain("Standing grants");
      expect(el.textContent).toContain("No standing grants yet");
    });

    it("promotes one staged write to the panel and rows everything else that is waiting", () => {
      const el = mount(
        makeProps({
          outbox: [outboxRow],
          needsAuth: [needsAuthRow],
          parked: [parkedRow],
          scopeRequests: [scopeRow],
        })
      );
      const panel = el.querySelector('[data-testid="staged-write"]');
      expect(panel).not.toBeNull();
      expect(panel?.textContent).toContain("Hi");
      // The draft is quoted in full, and every fact about where it goes is
      // stated before the commit — including the one that cannot be undone.
      expect(panel?.textContent).toContain("See you at 6.");
      expect(panel?.textContent).toContain("ravi@example.com");
      expect(panel?.textContent).toContain("nothing has been sent");
      expect(panel?.textContent).toContain(
        "approving sends it immediately and cannot be undone"
      );
      expect(el.textContent).toContain("Waiting on you");
      expect(sectionMeta(el, "Waiting on you")).toBe("4 waiting");
      expect(el.textContent).toContain("Also waiting");
      expect(sectionMeta(el, "Also waiting")).toBe("3");
      expect(el.textContent).toContain("work gmail");
      expect(el.textContent).toContain("social.send_message");
      expect(el.textContent).toContain("invoicer is asking for wider access");
    });

    it("keeps the deny out of the panel's action row, as its own destructive row", () => {
      const onDenyOutbox = vi.fn<ApprovalsScreenProps["onDenyOutbox"]>();
      const el = mount(makeProps({ outbox: [outboxRow], onDenyOutbox }));
      expect(el.textContent).toContain("Deny this write");
      expect(el.textContent).toContain(
        "Nothing is sent. The automation is told it was refused, and remembers."
      );
      const panel = el.querySelector('[data-testid="staged-write"]');
      expect(panel?.textContent).not.toContain("Deny this write");
      click(el, "Deny");
      expect(onDenyOutbox).toHaveBeenCalledWith("item1");
    });

    it("names who staged the write in words rather than a classifier chip", () => {
      const el = mount(makeProps({ outbox: [outboxRow] }));
      expect(el.textContent).toContain(
        "Outbound email · staged by the automation gmail-send · 5m ago"
      );

      const assistant = mount(
        makeProps({
          outbox: [
            { ...outboxRow, caller: "Assistant", callerKind: "assistant" },
          ],
        })
      );
      expect(assistant.textContent).toContain("staged by the assistant");

      const app = mount(
        makeProps({
          outbox: [{ ...outboxRow, caller: "Briefing", callerKind: "app" }],
        })
      );
      expect(app.textContent).toContain("staged by the app Briefing");

      const owner = mount(
        makeProps({
          outbox: [{ ...outboxRow, caller: "owner", callerKind: "owner" }],
        })
      );
      expect(owner.textContent).toContain("staged by owner");
    });

    it("fires onApproveOutbox with the always-allow state from the panel's commit", () => {
      const onApproveOutbox = vi.fn<ApprovalsScreenProps["onApproveOutbox"]>();
      const el = mount(makeProps({ outbox: [outboxRow], onApproveOutbox }));
      click(el, "Approve and send");
      expect(onApproveOutbox).toHaveBeenCalledWith("item1", false);

      const checkbox = el.querySelector(
        'input[type="checkbox"]'
      ) as HTMLInputElement;
      act(() => checkbox.click());
      click(el, "Approve and send");
      expect(onApproveOutbox).toHaveBeenLastCalledWith("item1", true);
    });

    it("offers Edit and approve only when the gateway can rebuild the request", () => {
      const notEditable = mount(makeProps({ outbox: [outboxRow] }));
      expect(() => findButton(notEditable, "Edit and approve")).toThrow(Error);
      expect(notEditable.textContent).toContain("cannot be edited");
      expect(notEditable.textContent).toContain(
        "approving sends exactly what is quoted above"
      );

      const editable = mount(makeProps({ outbox: [editableOutboxRow] }));
      expect(() => findButton(editable, "Edit and approve")).not.toThrow();
      expect(editable.textContent).not.toContain("cannot be edited");
    });

    it("edits in the row's own detail: strings become inputs, a string[] a comma field", () => {
      const el = mount(makeProps({ outbox: [editableOutboxRow] }));
      click(el, "Edit and approve");
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
      expect(() => findButton(el, "Approve with edits")).not.toThrow();
      expect(() => findButton(el, "Cancel")).not.toThrow();
    });

    it('submits the edited artifact on "Approve with edits", splitting recipients on comma', () => {
      const onApproveOutbox = vi.fn<ApprovalsScreenProps["onApproveOutbox"]>();
      const el = mount(
        makeProps({ outbox: [editableOutboxRow], onApproveOutbox })
      );
      click(el, "Edit and approve");
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
      click(el, "Approve with edits");
      expect(onApproveOutbox).toHaveBeenCalledWith("item1", false, {
        to: ["x@example.com", "y@example.com"],
        subject: "New subject",
        body: "New body.",
      });
    });

    it("Cancel leaves the editor without approving, and the quote survives", () => {
      const onApproveOutbox = vi.fn<ApprovalsScreenProps["onApproveOutbox"]>();
      const el = mount(
        makeProps({ outbox: [editableOutboxRow], onApproveOutbox })
      );
      click(el, "Edit and approve");
      click(el, "Cancel");
      expect(el.querySelector('input[aria-label="Subject"]')).toBeNull();
      expect(el.textContent).toContain("See you at 6.");
      expect(onApproveOutbox).not.toHaveBeenCalled();
    });

    it("withdraws the staged write's controls while its decision is in flight", () => {
      const el = mount(makeProps({ outbox: [outboxRow], busyId: "item1" }));
      expect(() => findButton(el, "Approve and send")).toThrow(Error);
      expect(() => findButton(el, "Deny")).toThrow(Error);
      // The write itself is still stated — only the verbs are gone.
      expect(el.textContent).toContain("Deny this write");
    });

    it("promotes a second staged write into the panel from its Review action", () => {
      const second: ApprovalsOutboxRowDTO = {
        ...outboxRow,
        itemId: "item2",
        subject: "Second draft",
      };
      const el = mount(makeProps({ outbox: [outboxRow, second] }));
      expect(
        el.querySelector<HTMLElement>('[data-testid="staged-write"]')?.dataset
          .itemId
      ).toBe("item1");
      click(el, "Review");
      expect(
        el.querySelector<HTMLElement>('[data-testid="staged-write"]')?.dataset
          .itemId
      ).toBe("item2");
    });

    it("puts the staged write an outbox notice names into the panel", () => {
      const other: ApprovalsOutboxRowDTO = {
        ...outboxRow,
        itemId: "item2",
        subject: "Second draft",
      };
      const props = makeProps({ outbox: [outboxRow, other] });
      const el = mount(props);
      rerender({ ...props, focusOutbox: { itemId: "item2", nonce: 1 } });
      expect(
        el.querySelector<HTMLElement>('[data-testid="staged-write"]')?.dataset
          .itemId
      ).toBe("item2");
      expect(el.textContent).toContain("Second draft");
    });

    it("falls back to the head of the queue when the deep-linked item is gone", () => {
      const props = makeProps({ outbox: [outboxRow] });
      const el = mount(props);
      rerender({ ...props, focusOutbox: { itemId: "decided", nonce: 1 } });
      expect(
        el.querySelector<HTMLElement>('[data-testid="staged-write"]')?.dataset
          .itemId
      ).toBe("item1");
    });

    it("filters the queue by chip once it is long enough to need one, and says so", () => {
      const el = mount(
        makeProps({
          outbox: [outboxRow, { ...outboxRow, itemId: "item2" }],
          needsAuth: [needsAuthRow],
          parked: [parkedRow],
          scopeRequests: [scopeRow],
        })
      );
      expect(sectionMeta(el, "Waiting on you")).toBe("5 waiting");
      click(el, "Authorization");
      expect(sectionMeta(el, "Waiting on you")).toBe("showing 2 of 5");
      expect(el.textContent).toContain("work gmail");
      expect(el.textContent).not.toContain("social.send_message");
      expect(el.querySelector('[data-testid="staged-write"]')).toBeNull();
      click(el, "Everything");
      expect(sectionMeta(el, "Waiting on you")).toBe("5 waiting");
    });

    it("shows no filter chips while the queue is short enough to read", () => {
      const el = mount(makeProps({ outbox: [outboxRow] }));
      expect(() => findButton(el, "Everything")).toThrow(Error);
    });

    it("drops the filter and re-heads the queue on the bar's Review all verb", () => {
      const props = makeProps({
        outbox: [outboxRow, { ...outboxRow, itemId: "item2" }],
        needsAuth: [needsAuthRow],
        parked: [parkedRow],
        scopeRequests: [scopeRow],
      });
      const el = mount(props);
      click(el, "Authorization");
      expect(el.querySelector('[data-testid="staged-write"]')).toBeNull();
      rerender({ ...props, reviewAll: { nonce: 1 } });
      expect(
        el.querySelector<HTMLElement>('[data-testid="staged-write"]')?.dataset
          .itemId
      ).toBe("item1");
    });

    it("routes needs-auth reconnection through onOpenSettings", () => {
      const onOpenSettings = vi.fn<ApprovalsScreenProps["onOpenSettings"]>();
      const el = mount(
        makeProps({ needsAuth: [needsAuthRow], onOpenSettings })
      );
      click(el, "Reconnect");
      expect(onOpenSettings).toHaveBeenCalledWith();
    });

    it("decides a parked invocation from the row's own detail, over its input", () => {
      const onConfirmParked = vi.fn<ApprovalsScreenProps["onConfirmParked"]>();
      const el = mount(makeProps({ parked: [parkedRow], onConfirmParked }));
      expect(el.textContent).toContain("asked by the app Briefing");
      click(el, "Review");
      expect(el.textContent).toContain('"to": "x"');
      click(el, "Approve");
      expect(onConfirmParked).toHaveBeenCalledWith("inv1", true);
    });

    it("distinguishes an assistant-asked parked invocation from an automation's", () => {
      const el = mount(
        makeProps({
          parked: [
            { ...parkedRow, caller: "Assistant", callerKind: "assistant" },
          ],
        })
      );
      expect(el.textContent).toContain("asked by the assistant");

      const automation = mount(
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
      expect(automation.textContent).toContain(
        "asked by the automation E2e Agent Purge Demo"
      );
    });

    it("decides a scope request from its expanded detail", () => {
      const onDecideScopeRequest =
        vi.fn<ApprovalsScreenProps["onDecideScopeRequest"]>();
      const el = mount(
        makeProps({ scopeRequests: [scopeRow], onDecideScopeRequest })
      );
      click(el, "Review");
      expect(el.textContent).toContain("business.invoice (act)");
      click(el, "Deny");
      expect(onDecideScopeRequest).toHaveBeenCalledWith("r1", false);
    });

    it("renders standing grants with a Revoke action and the rule under them", () => {
      const onRevokeGrant = vi.fn<ApprovalsScreenProps["onRevokeGrant"]>();
      const el = mount(makeProps({ grants: [grantRow], onRevokeGrant }));
      expect(el.textContent).toContain("gmail-send may always gmail.send");
      expect(el.textContent).toContain("ravi@example.com");
      expect(el.textContent).toContain(
        "A standing grant skips this page for one narrow thing; revoking one takes effect on the next run."
      );
      click(el, "Revoke");
      expect(onRevokeGrant).toHaveBeenCalledWith("g1");
    });

    it("keeps notices in the queue when they are a demand and in Updates when they are news", () => {
      const onReadNotice =
        vi.fn<NonNullable<ApprovalsScreenProps["onReadNotice"]>>();
      const onArchiveNotice =
        vi.fn<NonNullable<ApprovalsScreenProps["onArchiveNotice"]>>();
      const el = mount(
        makeProps({
          notices: [
            noticeRow(),
            noticeRow({
              noticeId: "notice-info",
              headline: "Local recovered",
              severity: "info",
            }),
          ],
          onReadNotice,
          onArchiveNotice,
        })
      );
      expect(sectionMeta(el, "Waiting on you")).toBe("1 waiting");
      expect(el.textContent).toContain("Digest failed");
      expect(el.textContent).toContain("Updates");
      expect(el.textContent).toContain("Local recovered");
      // The collapsed multiplicity rides the sub line as a duration phrase.
      expect(el.textContent).toContain("failing for 1 day");
      expect(el.textContent).toContain("brief/digest");
      click(el, "Mark read");
      click(el, "Archive");
      expect(onReadNotice).toHaveBeenCalledWith("notice-1");
      expect(onArchiveNotice).toHaveBeenCalledWith("notice-1");
    });

    it("opens a notice at its own surface and keeps archived ones in their section", () => {
      const onOpenNotice =
        vi.fn<NonNullable<ApprovalsScreenProps["onOpenNotice"]>>();
      const el = mount(
        makeProps({
          notices: [
            noticeRow(),
            noticeRow({
              noticeId: "archived-notice",
              headline: "Old failure",
              archivedAt: "2026-07-30T02:00:00.000Z",
            }),
          ],
          onOpenNotice,
        })
      );
      expect(el.textContent).toContain("Archived");
      expect(el.textContent).toContain("Old failure");
      click(el, "Open");
      expect(onOpenNotice).toHaveBeenCalledWith(
        expect.objectContaining({ noticeId: "notice-1" })
      );
    });

    it("lists each store's holders and says 'reachable by nothing' when it has none", () => {
      const el = mount(
        makeProps({
          storeGrants: [
            {
              storeId: "photos",
              label: "Photos",
              holders: [
                {
                  grantId: "g-photos",
                  holderKind: "app",
                  holderId: "photos",
                  holderLabel: "Photos",
                  mode: "read",
                },
              ],
            },
            { storeId: "locker", label: "Locker", holders: [] },
          ],
        })
      );
      expect(el.querySelector('[data-testid="privacy-ledger"]')).not.toBeNull();
      expect(el.querySelectorAll('[data-testid="privacy-store"]')).toHaveLength(
        2
      );
      expect(el.textContent).toContain("Photos");
      expect(el.textContent).toContain("read access");
      expect(el.textContent).toContain("1 app");
      expect(el.textContent).toContain("Locker");
      expect(el.textContent).toContain("reachable by nothing");
      expect(el.textContent).toContain(
        "Everything an app can reach, and nothing it cannot."
      );
      // The footer names every real call the product makes off this device.
      expect(el.textContent).toContain("Your configured AI provider");
      expect(el.textContent).toContain("The pairing relay");
    });

    it("revoking a store grant switches the row off instead of removing it", () => {
      const onRevokeStoreGrant =
        vi.fn<ApprovalsScreenProps["onRevokeStoreGrant"]>();
      const el = mount(
        makeProps({
          storeGrants: [
            {
              storeId: "photos",
              label: "Photos",
              holders: [
                {
                  grantId: "g-photos",
                  holderKind: "app",
                  holderId: "photos",
                  holderLabel: "Photos",
                  mode: "write",
                },
              ],
            },
          ],
          onRevokeStoreGrant,
        })
      );
      click(el, "Revoke");
      expect(onRevokeStoreGrant).toHaveBeenCalledWith(
        expect.objectContaining({ grantId: "g-photos", holderLabel: "Photos" })
      );
      // The row survives, switched off — the history of who once held access
      // stays legible.
      expect(el.textContent).toContain("Photos");
      expect(el.textContent).toContain("write access");
      expect(el.querySelector('[data-off="true"]')).not.toBeNull();
    });

    it("shows the origin of a recent Locker fill in the history", () => {
      const el = mount(makeProps({ activity: [fillActivity] }));
      expect(el.textContent).toContain("Recent activity");
      expect(el.textContent).toContain("Locker filled a login");
      expect(el.textContent).toContain("https://example.test");
    });

    it("states each receipt's decision, risk and attribution on the row", () => {
      const el = mount(
        makeProps({
          activity: [
            activityRow({
              receiptId: "a1",
              decision: "allow",
              label: "Allowed act",
              risk: "high",
              attribution: "grant",
              grantId: "grant-42",
            }),
            activityRow({
              receiptId: "a2",
              decision: "deny",
              label: "Denied act",
            }),
          ],
        })
      );
      expect(el.textContent).toContain("Allowed · high risk");
      expect(el.textContent).toContain("auto-allowed by a standing grant");
      expect(el.textContent).toContain("Denied");
      expect(el.textContent).toContain("by the automation gmail-send");
    });

    it("expands an activity row to the full object id, absolute time and grant revoke", () => {
      const onRevokeGrant = vi.fn<ApprovalsScreenProps["onRevokeGrant"]>();
      const el = mount(
        makeProps({
          activity: [
            activityRow({
              label: "Remove connection",
              objectId: "cmd-abc123def456",
              objectType: "agent.command",
              occurredAt: "2026-03-01T12:00:00.000Z",
              grantId: "grant-42",
              attribution: "grant",
            }),
          ],
          onRevokeGrant,
        })
      );
      expect(el.querySelector('[data-testid="activity-detail"]')).toBeNull();
      click(el, "Details");
      const detail = el.querySelector('[data-testid="activity-detail"]');
      expect(detail?.textContent).toContain("cmd-abc123def456");
      expect(detail?.textContent).toContain("agent.command");
      expect(detail?.textContent).toMatch(/2026|Mar|03/u);
      click(el, "Revoke grant");
      expect(onRevokeGrant).toHaveBeenCalledWith("grant-42");
    });

    it("collapses adjacent duplicates onto one row with a ×N count", () => {
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
      expect(el.textContent).toContain("Draft drop ×3");
    });

    it("filters the history to denied-only, and says how much it is showing", () => {
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
      expect(el.textContent).toContain("Allowed row");
      click(el, "Denied");
      expect(el.textContent).not.toContain("Allowed row");
      expect(el.textContent).toContain("Denied row");
      expect(sectionMeta(el, "Recent activity")).toBe("showing 1 of 2");
    });

    it("shows See all only when the feed is truncated, and fires onSeeAllActivity", () => {
      const onSeeAllActivity =
        vi.fn<NonNullable<ApprovalsScreenProps["onSeeAllActivity"]>>();
      const el = mount(
        makeProps({
          activity: [activityRow()],
          activityTruncated: true,
          onSeeAllActivity,
        })
      );
      expect(
        el.querySelector('[data-testid="activity-see-all"]')
      ).not.toBeNull();
      click(el, "See all");
      expect(onSeeAllActivity).toHaveBeenCalledWith();

      const untruncated = mount(
        makeProps({ activity: [activityRow()], activityTruncated: false })
      );
      expect(
        untruncated.querySelector('[data-testid="activity-see-all"]')
      ).toBeNull();
    });
  });
});

describe("notification presentation helpers", () => {
  it("names an actor in words, and falls back to the bare name it was given", () => {
    expect(callerPhrase("app", "Briefing")).toBe("the app Briefing");
    expect(callerPhrase("agent", "gmail-send")).toBe(
      "the automation gmail-send"
    );
    expect(callerPhrase("assistant", "Assistant")).toBe("the assistant");
    expect(callerPhrase("owner", "owner")).toBe("owner");
  });

  it("names the kind of outbound write from the connection and the verb only", () => {
    expect(
      outboundLabel({ verb: "gmail.send", connectionKind: "pull.gmail" })
    ).toBe("Outbound email");
    expect(
      outboundLabel({ verb: "slack.post", connectionKind: "push.slack" })
    ).toBe("Outbound message");
    expect(
      outboundLabel({ verb: "sheets.append", connectionKind: "push.sheets" })
    ).toBe("Outbound write");
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

  it("re-attaches a revoked holder the live group no longer carries", () => {
    const holder = {
      grantId: "g-photos",
      holderKind: "app" as const,
      holderId: "photos",
      holderLabel: "Photos",
      mode: "read" as const,
    };
    const revoked = new Map([[revokedHolderKey("photos", "g-photos"), holder]]);
    expect(
      mergeRevokedHolders(
        { storeId: "photos", label: "Photos", holders: [] },
        revoked
      ).holders
    ).toHaveLength(1);
    // Still live server-side: no duplicate row.
    expect(
      mergeRevokedHolders(
        { storeId: "photos", label: "Photos", holders: [holder] },
        revoked
      ).holders
    ).toHaveLength(1);
    // A different store's key never reattaches here.
    expect(
      mergeRevokedHolders(
        { storeId: "locker", label: "Locker", holders: [] },
        revoked
      ).holders
    ).toHaveLength(0);
  });
});
