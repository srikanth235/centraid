// governance: allow-repo-hygiene file-size-limit (#765) one suite per screen — staged write, waiting queue, grants, ledger, history and the five states all exercise the single ApprovalsScreen contract and share its mount fixtures
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  arrivalCount,
  blockingIds,
  callerPhrase,
  isAuthorableKey,
  noticeSeverityLabel,
  noticeSpanPhrase,
  outboundLabel,
} from "../shell/routes/approvalsData.js";
// The surface's presentation rules moved out of the component with the v11
// pass (#815) — the phrasings to `approvalsData`, the store ledger's
// revoked-row bookkeeping to `privacyStores` — and this suite keeps exercising
// them beside the screen they are the contract for.
import ApprovalsScreen from "./ApprovalsScreen.js";
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
import { mergeRevokedHolders, revokedHolderKey } from "./privacyStores.js";

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
  /** Press one section head's own Show/Hide, rather than the first button in
   *  the page that happens to carry the same word. */
  function toggleSection(el: HTMLElement, label: string): void {
    const head = [...el.querySelectorAll("h2")].find(
      (h) => h.textContent === label
    );
    const btn = head?.parentElement?.querySelector("button");
    if (!btn) throw new Error(`no toggle on section "${label}"`);
    act(() => btn.click());
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

    it("gives every blocking decision its own card, closed until it is reviewed", () => {
      const el = mount(
        makeProps({
          outbox: [outboxRow],
          needsAuth: [needsAuthRow],
          parked: [parkedRow],
          scopeRequests: [scopeRow],
        })
      );
      const card = el.querySelector('[data-testid="staged-write"]');
      expect(card).not.toBeNull();
      // Closed: the kind, the title and the sub, and one outlined Review.
      expect(card?.textContent).toContain("Staged write · personal");
      expect(card?.textContent).toContain("Hi");
      expect(card?.textContent).not.toContain("nothing has been sent");
      expect(card?.textContent).not.toContain("See you at 6.");
      expect(el.textContent).toContain("Waiting on you");
      expect(sectionMeta(el, "Waiting on you")).toBe("4 waiting");
      expect(el.textContent).toContain("work gmail");
      expect(el.textContent).toContain("social.send_message");
      expect(el.textContent).toContain("invoicer asks for wider access");
      // The whole title block is the disclosure — one target for one act.
      expect(card?.querySelector("button[aria-expanded]")).not.toBeNull();
    });

    it("opens a staged write to its facts, its quote and three verbs", () => {
      const el = mount(makeProps({ outbox: [outboxRow] }));
      click(el, "Review");
      const card = el.querySelector('[data-testid="staged-write"]');
      // The draft is quoted in full, and every fact about where it goes is
      // stated before the commit — including the one that cannot be undone.
      expect(card?.textContent).toContain("See you at 6.");
      expect(card?.textContent).toContain("what it would do");
      expect(card?.textContent).toContain("ravi@example.com");
      expect(card?.textContent).toContain("nothing has been sent");
      expect(card?.textContent).toContain(
        "approving sends it immediately and cannot be undone"
      );
      expect(() => findButton(el, "Approve")).not.toThrow();
      expect(() => findButton(el, "Discard")).not.toThrow();
    });

    it("confirms a discard in place, in --net, and keeps it on Keep it", () => {
      const onDenyOutbox = vi.fn<ApprovalsScreenProps["onDenyOutbox"]>();
      const el = mount(makeProps({ outbox: [outboxRow], onDenyOutbox }));
      click(el, "Review");
      click(el, "Discard");
      const card = el.querySelector<HTMLElement>(
        '[data-testid="staged-write"] section'
      );
      expect(card?.dataset.confirm).toBe("true");
      expect(el.textContent).toContain(
        "Irreversible — nothing is written and the draft is destroyed."
      );
      // The commit is withdrawn while the question is open: a confirm that
      // still offers Approve is not a confirm.
      expect(() => findButton(el, "Approve")).toThrow(Error);
      click(el, "Keep it");
      expect(onDenyOutbox).not.toHaveBeenCalled();
      click(el, "Discard");
      click(el, "Do it");
      expect(onDenyOutbox).toHaveBeenCalledWith("item1");
    });

    it("states the consequence the route gives it, in the gateway's terms", () => {
      const el = mount(
        makeProps({
          discardConsequence: "Nothing will be sent.",
          outbox: [outboxRow],
        })
      );
      click(el, "Review");
      click(el, "Discard");
      expect(el.textContent).toContain("Nothing will be sent.");
    });

    it("names who staged the write in words rather than a classifier chip", () => {
      const el = mount(makeProps({ outbox: [outboxRow] }));
      expect(el.textContent).toContain(
        "Outbound email · staged by the automation gmail-send"
      );
      // The age is its own slot on the eyebrow row, in the numeric register.
      expect(el.textContent).toContain("5m ago");

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

    it("fires onApproveOutbox with the always-allow state from the card's commit", () => {
      const onApproveOutbox = vi.fn<ApprovalsScreenProps["onApproveOutbox"]>();
      const el = mount(makeProps({ outbox: [outboxRow], onApproveOutbox }));
      click(el, "Review");
      click(el, "Approve");
      expect(onApproveOutbox).toHaveBeenCalledWith("item1", false);

      // The offer is made where the decision is made, and says what it costs
      // the next time.
      const checkbox = el.querySelector(
        'input[type="checkbox"]'
      ) as HTMLInputElement;
      expect(el.textContent).toContain("Approve without asking again");
      expect(el.textContent).toContain(
        "the automation gmail-send may gmail.send → ravi@example.com without asking again."
      );
      act(() => checkbox.click());
      click(el, "Approve");
      expect(onApproveOutbox).toHaveBeenLastCalledWith("item1", true);
    });

    it("refuses Edit and approve honestly when the gateway cannot rebuild it", () => {
      const notEditable = mount(makeProps({ outbox: [outboxRow] }));
      click(notEditable, "Review");
      // The verb is present and inert, with the reason stated as a fact — not
      // silently absent, which reads as a build that forgot it.
      expect(findButton(notEditable, "Edit and approve").disabled).toBe(true);
      expect(notEditable.textContent).toContain("cannot be edited");
      expect(notEditable.textContent).toContain(
        "approving sends exactly what is quoted above"
      );

      const editable = mount(makeProps({ outbox: [editableOutboxRow] }));
      click(editable, "Review");
      expect(findButton(editable, "Edit and approve").disabled).toBe(false);
      expect(editable.textContent).not.toContain("cannot be edited");
    });

    it("edits in the card's own facts: strings become inputs, a string[] a comma field", () => {
      const el = mount(makeProps({ outbox: [editableOutboxRow] }));
      click(el, "Review");
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
      click(el, "Review");
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
      click(el, "Review");
      click(el, "Edit and approve");
      click(el, "Cancel");
      expect(el.querySelector('input[aria-label="Subject"]')).toBeNull();
      expect(el.textContent).toContain("See you at 6.");
      expect(onApproveOutbox).not.toHaveBeenCalled();
    });

    it("keeps a half-typed edit through a refusal, with the gateway's words", () => {
      const props = makeProps({ outbox: [editableOutboxRow] });
      const el = mount(props);
      click(el, "Review");
      click(el, "Edit and approve");
      const subject = el.querySelector(
        'input[aria-label="Subject"]'
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      act(() => {
        setter?.call(subject, "Half typed");
        subject.dispatchEvent(new Event("input", { bubbles: true }));
      });
      click(el, "Approve with edits");
      rerender({
        ...props,
        refusal: {
          itemId: "item1",
          message: "repo.comment: token expired",
          nonce: 1,
        },
      });
      expect(el.textContent).toContain("The gateway refused that approval");
      expect(el.textContent).toContain("repo.comment: token expired");
      expect(
        (el.querySelector('input[aria-label="Subject"]') as HTMLInputElement)
          .value
      ).toBe("Half typed");
    });

    it("withdraws the staged write's verbs while its decision is in flight", () => {
      const props = makeProps({ outbox: [outboxRow] });
      const el = mount(props);
      click(el, "Review");
      rerender({ ...props, busyId: "item1" });
      expect(() => findButton(el, "Approve")).toThrow(Error);
      expect(() => findButton(el, "Discard")).toThrow(Error);
      // The write itself is still stated — only the verbs are gone.
      expect(el.textContent).toContain("nothing has been sent");
    });

    it("opens a second staged write from its own Review, closing the first", () => {
      const second: ApprovalsOutboxRowDTO = {
        ...outboxRow,
        itemId: "item2",
        subject: "Second draft",
      };
      const el = mount(makeProps({ outbox: [outboxRow, second] }));
      expect(el.querySelectorAll('[data-testid="staged-write"]')).toHaveLength(
        2
      );
      expect(
        el.querySelector('[data-testid="staged-write"][data-open]')
      ).toBeNull();
      const reviews = [...el.querySelectorAll("button")].filter(
        (b) => b.textContent === "Review"
      );
      act(() => reviews[1]?.click());
      expect(
        el.querySelector<HTMLElement>(
          '[data-testid="staged-write"][data-open="true"]'
        )?.dataset.itemId
      ).toBe("item2");
    });

    it("opens the staged write an outbox notice names", () => {
      const other: ApprovalsOutboxRowDTO = {
        ...outboxRow,
        itemId: "item2",
        subject: "Second draft",
      };
      const props = makeProps({ outbox: [outboxRow, other] });
      const el = mount(props);
      rerender({ ...props, focusOutbox: { itemId: "item2", nonce: 1 } });
      expect(
        el.querySelector<HTMLElement>(
          '[data-testid="staged-write"][data-open="true"]'
        )?.dataset.itemId
      ).toBe("item2");
      expect(el.textContent).toContain("Second draft");
    });

    it("opens nothing when the deep-linked item has already been decided", () => {
      const props = makeProps({ outbox: [outboxRow] });
      const el = mount(props);
      rerender({ ...props, focusOutbox: { itemId: "decided", nonce: 1 } });
      // The queue is left exactly as it is, rather than pointing at a card
      // that isn't there.
      expect(
        el.querySelector('[data-testid="staged-write"][data-open="true"]')
      ).toBeNull();
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
        el.querySelector<HTMLElement>(
          '[data-testid="staged-write"][data-open="true"]'
        )?.dataset.itemId
      ).toBe("item1");
    });

    it("sends a lapsed connection to Connectors, where re-authorizing happens", () => {
      const onOpenSettings = vi.fn<ApprovalsScreenProps["onOpenSettings"]>();
      const el = mount(
        makeProps({ needsAuth: [needsAuthRow], onOpenSettings })
      );
      expect(el.textContent).toContain("Authorization · work gmail");
      expect(el.textContent).toContain("work gmail needs re-authorizing");
      click(el, "Open Connectors");
      expect(onOpenSettings).toHaveBeenCalledWith();
    });

    it("decides a parked invocation from its own card, over its input", () => {
      const onConfirmParked = vi.fn<ApprovalsScreenProps["onConfirmParked"]>();
      const el = mount(makeProps({ parked: [parkedRow], onConfirmParked }));
      expect(el.textContent).toContain("asked by the app Briefing");
      click(el, "Review");
      expect(el.textContent).toContain('"to": "x"');
      click(el, "Approve");
      expect(onConfirmParked).toHaveBeenCalledWith("inv1", true);
    });

    it("confirms a parked denial in place, naming who must ask again", () => {
      const onConfirmParked = vi.fn<ApprovalsScreenProps["onConfirmParked"]>();
      const el = mount(makeProps({ parked: [parkedRow], onConfirmParked }));
      click(el, "Review");
      click(el, "Deny");
      expect(el.textContent).toContain(
        "A denied command cannot be replayed — Briefing must ask again."
      );
      click(el, "Do it");
      expect(onConfirmParked).toHaveBeenCalledWith("inv1", false);
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

    it("decides a scope request from its opened card, confirming the denial", () => {
      const onDecideScopeRequest =
        vi.fn<ApprovalsScreenProps["onDecideScopeRequest"]>();
      const el = mount(
        makeProps({ scopeRequests: [scopeRow], onDecideScopeRequest })
      );
      click(el, "Review");
      expect(el.textContent).toContain("business.invoice (act)");
      expect(() => findButton(el, "Approve the wider access")).not.toThrow();
      click(el, "Deny");
      expect(el.textContent).toContain(
        "invoicer keeps what it has, and is not asked again."
      );
      click(el, "Do it");
      expect(onDecideScopeRequest).toHaveBeenCalledWith("r1", false);
    });

    it("renders standing grants with a Revoke that states what re-parks", () => {
      const onRevokeGrant = vi.fn<ApprovalsScreenProps["onRevokeGrant"]>();
      const el = mount(makeProps({ grants: [grantRow], onRevokeGrant }));
      expect(el.textContent).toContain("gmail-send may always gmail.send");
      expect(el.textContent).toContain("ravi@example.com");
      expect(el.textContent).toContain(
        "A standing grant skips this page for one narrow thing; revoking one takes effect on the next run."
      );
      click(el, "Revoke");
      expect(el.textContent).toContain(
        "Matching items park for review again, including anything approved but not yet drained."
      );
      expect(onRevokeGrant).not.toHaveBeenCalled();
      click(el, "Do it");
      expect(onRevokeGrant).toHaveBeenCalledWith("g1");
    });

    it("opens and closes the record's sections from their own heads", () => {
      const el = mount(makeProps({ grants: [grantRow] }));
      expect(el.textContent).toContain("gmail-send may always gmail.send");
      toggleSection(el, "Standing grants");
      expect(el.textContent).not.toContain("gmail-send may always gmail.send");
      toggleSection(el, "Standing grants");
      expect(el.textContent).toContain("gmail-send may always gmail.send");
    });

    it("keeps a demanding notice in the queue and files news under Notices", () => {
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
      expect(el.textContent).toContain("Failed · brief/digest");
      expect(el.textContent).toContain("Notices");
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
        "Everything an app can reach — revoking takes effect at once."
      );
      // The footer names every real call the product makes off this device.
      expect(el.textContent).toContain("Your configured AI provider");
      expect(el.textContent).toContain("The pairing relay");
    });

    // The enrichment egress ledger (issue #807, Wave 3). Reference material,
    // read back: every answer is shown, the refusals included, and none of
    // them is a control.
    it("lists the enrichment egress answers, declines and all, with no verb", () => {
      const el = mount(
        makeProps({
          enrichConsent: [
            {
              id: "faces:provider:",
              title: "Faces",
              sub: "Declined · at a third-party provider · this vault · 2 days ago",
              meta: "provider",
            },
            {
              id: "ocr:on-device:",
              title: "Ocr",
              sub: "Granted · on this device · this vault · 5 days ago",
              meta: "on-device",
            },
          ],
        })
      );

      const section = el.querySelector('[data-testid="enrichment-consent"]');
      expect(section).not.toBeNull();
      expect(section?.textContent).toContain("Faces");
      expect(section?.textContent).toContain("Declined");
      expect(section?.textContent).toContain("Granted");
      expect(section?.textContent).toContain("Asked once, answered once");
      // Nothing here decides anything — the answer is given where it is asked.
      // The only control in the section is the head's own Show/Hide.
      expect(
        [...section!.querySelectorAll("button")].map((b) => b.textContent)
      ).toStrictEqual(["Hide"]);
    });

    it("says nothing at all when no enrichment question has been answered", () => {
      const el = mount(makeProps({}));
      expect(el.querySelector('[data-testid="enrichment-consent"]')).toBeNull();
    });

    it("says an old gateway cannot be asked, rather than showing no answers", () => {
      const el = mount(makeProps({ enrichConsentReadable: false }));
      const section = el.querySelector('[data-testid="enrichment-consent"]');
      expect(section?.textContent).toContain(
        "This gateway is older than the consent ledger"
      );
      expect(section?.textContent).toContain(
        "It cannot say which questions were answered."
      );
      expect(sectionMeta(el, "Answers about what may leave")).toBe(
        "not readable here"
      );
    });

    it("revoking a store grant strikes the row through instead of removing it", () => {
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
      // The consequence is stated before the row is struck, in the holder's
      // own name.
      expect(el.textContent).toContain("Photos loses that store");
      expect(el.textContent).toContain(
        "It cannot read again, and the row stays, struck through."
      );
      expect(onRevokeStoreGrant).not.toHaveBeenCalled();
      click(el, "Do it");
      expect(onRevokeStoreGrant).toHaveBeenCalledWith(
        expect.objectContaining({ grantId: "g-photos", holderLabel: "Photos" })
      );
      // The row survives, struck through and switched off — the history of
      // who once held access stays legible.
      expect(el.textContent).toContain("Photos");
      expect(el.textContent).toContain("write access");
      expect(el.querySelector('[data-off="true"]')).not.toBeNull();
      expect(el.querySelector('[data-struck="true"]')).not.toBeNull();
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

    it("expands an activity row to the full object id, absolute time and its grant", () => {
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
          grants: [grantRow],
        })
      );
      expect(el.querySelector('[data-testid="activity-detail"]')).toBeNull();
      click(el, "Details");
      const detail = el.querySelector('[data-testid="activity-detail"]');
      expect(detail?.textContent).toContain("cmd-abc123def456");
      expect(detail?.textContent).toContain("agent.command");
      expect(detail?.textContent).toMatch(/2026|Mar|03/u);
      // The rule that decided this opens where rules are revoked — one
      // revoke, in one place, rather than a second one down here.
      toggleSection(el, "Standing grants");
      expect(el.textContent).not.toContain("gmail-send may always gmail.send");
      click(el, "Open the grant");
      expect(el.textContent).toContain("gmail-send may always gmail.send");
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

    it("holds live arrivals back while the member is part-way through one", () => {
      const props = makeProps({ outbox: [editableOutboxRow] });
      const el = mount(props);
      click(el, "Review");
      click(el, "Edit and approve");
      const second: ApprovalsOutboxRowDTO = {
        ...outboxRow,
        itemId: "item2",
        subject: "Arrived while editing",
      };
      rerender({ ...props, outbox: [editableOutboxRow, second] });
      // The list the member is working in does not move under them.
      expect(el.textContent).not.toContain("Arrived while editing");
      expect(el.querySelector('[data-testid="held-tray"]')).not.toBeNull();
      expect(el.textContent).toContain("1 more arrived");
      expect(el.textContent).toContain(
        "Held back while you are part-way through an item."
      );
      click(el, "Add them");
      expect(el.textContent).toContain("Arrived while editing");
      expect(el.querySelector('[data-testid="held-tray"]')).toBeNull();
    });

    it("lets a refresh through while nothing is part-way through", () => {
      const props = makeProps({ outbox: [outboxRow] });
      const el = mount(props);
      click(el, "Review");
      const second: ApprovalsOutboxRowDTO = {
        ...outboxRow,
        itemId: "item2",
        subject: "Arrived while reading",
      };
      rerender({ ...props, outbox: [outboxRow, second] });
      // Reading is not work in progress: an expanded card survives the list
      // growing under it, and nothing is held.
      expect(el.textContent).toContain("Arrived while reading");
      expect(el.querySelector('[data-testid="held-tray"]')).toBeNull();
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

    it("links the durable alert history rather than restating it", () => {
      const onOpenAlertHistory =
        vi.fn<NonNullable<ApprovalsScreenProps["onOpenAlertHistory"]>>();
      const el = mount(
        makeProps({ activity: [activityRow()], onOpenAlertHistory })
      );
      expect(el.textContent).toContain("Gateway alert history");
      expect(el.textContent).toContain(
        "Machine health lives on System, not here."
      );
      click(el, "Open");
      expect(onOpenAlertHistory).toHaveBeenCalledWith();
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

  it("offers only fields a member can AUTHOR as editable", () => {
    const artifact = {
      body: "hello",
      files: ["a.ts", "b.ts"],
      fileCount: "3",
      path: "~/projects/pemberton",
      size: "4.2 KB",
      undo: "10 minutes",
      window: { start: 1 },
    };
    expect(isAuthorableKey(artifact, "path")).toBe(true);
    expect(isAuthorableKey(artifact, "body")).toBe(true);
    // Computed by the actor: a size, a count, a retention window, a file list.
    expect(isAuthorableKey(artifact, "size")).toBe(false);
    expect(isAuthorableKey(artifact, "undo")).toBe(false);
    expect(isAuthorableKey(artifact, "files")).toBe(false);
    expect(isAuthorableKey(artifact, "fileCount")).toBe(false);
    // Not a shape the gateway's drift guard accepts at all.
    expect(isAuthorableKey(artifact, "window")).toBe(false);
  });

  it("counts what ARRIVED, so the tray never says a departure is an arrival", () => {
    const empty = {
      needsAuth: [],
      outbox: [],
      parked: [],
      scopeRequests: [],
    };
    const shown = { ...empty, outbox: [outboxRow] };
    const next = {
      ...empty,
      outbox: [outboxRow, { ...outboxRow, itemId: "item2" }],
      parked: [parkedRow],
    };
    expect([...blockingIds(shown)]).toStrictEqual(["item1"]);
    expect(arrivalCount(shown, next)).toBe(2);
    // A decided item leaving is not an arrival.
    expect(arrivalCount(next, shown)).toBe(0);
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
