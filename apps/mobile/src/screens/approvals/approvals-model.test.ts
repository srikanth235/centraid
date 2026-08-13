// What the Notifications place says (#765, spec §2) — the copy contract,
// under test without a renderer.
//
// The sentences that state a RULE are asserted verbatim: they are promises
// about what approving does, and a promise that drifts is a promise broken.

import { describe, expect, it } from "vitest";

import type { MobileNotice, MobileOutboxRow } from "../../lib/gateway";
import {
  DENY_SUB,
  DENY_TITLE,
  EMPTY_BODY,
  GRANTS_NOTE,
  LOADING_NOTE,
  SENDING_FACT_KEY,
  SENDING_FACT_VALUE,
  agoPhrase,
  approvalsHealth,
  callerPhrase,
  grantRowCopy,
  isAttention,
  matchesFilter,
  needsAuthRowCopy,
  noticeRowCopy,
  noticeSeverityLabel,
  noticeSpanPhrase,
  opsStateFor,
  outboundLabel,
  outboxRowCopy,
  parkedRowCopy,
  scopeRowCopy,
  stagedBody,
  stagedEyebrow,
  stagedFacts,
  stagedTitle,
  waitingMeta,
  waitingTotal,
} from "./approvals-model";

const NOW = Date.parse("2026-08-13T09:00:00.000Z");

function outbox(over: Partial<MobileOutboxRow> = {}): MobileOutboxRow {
  return {
    actor: "the assistant",
    actorKind: "assistant",
    artifact: {
      body: "Tom — the survey arrived on Tuesday.",
      cc: "ana@pemberton.example",
      from: "alex@pemberton.example",
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

function notice(over: Partial<MobileNotice> = {}): MobileNotice {
  return {
    archivedAt: null,
    count: 1,
    detail: {},
    firstAt: "2026-08-13T08:00:00.000Z",
    headline: "Weekly digest failed",
    kind: "automation-failed",
    lastAt: "2026-08-13T08:30:00.000Z",
    noticeId: "n-1",
    readAt: null,
    severity: "warning",
    sourceRef: "a-1",
    ...over,
  };
}

describe("the staged write", () => {
  it("quotes the body, titles by the subject, and states what approving does", () => {
    const row = outbox();
    expect(stagedTitle(row)).toBe("The survey came back");
    expect(stagedBody(row)).toBe("Tom — the survey arrived on Tuesday.");
    const facts = stagedFacts(row);
    // The addressed fields come first, in the order an envelope is read.
    expect(facts.slice(0, 3).map((fact) => fact.key)).toStrictEqual([
      "to",
      "cc",
      "from",
    ]);
    // The irreversibility fact is LAST and is the one chromatic value on the
    // panel: it changes what the commit beside it means.
    const last = facts.at(-1);
    expect(last?.key).toBe(SENDING_FACT_KEY);
    expect(last?.value).toBe(SENDING_FACT_VALUE);
    expect(last?.net).toBe(true);
    // Neither the quoted body nor the title is repeated as a fact.
    expect(facts.map((fact) => fact.key)).not.toContain("body");
    expect(facts.map((fact) => fact.key)).not.toContain("subject");
  });

  it("says so, rather than offering an edit, when the verb has no rebuilder", () => {
    const facts = stagedFacts(outbox({ canEdit: false }));
    expect(facts.map((fact) => fact.key)).toContain("cannot be edited");
  });

  it("keeps every other staged field visible instead of hiding it", () => {
    const facts = stagedFacts(
      outbox({ artifact: { attachments: ["survey.pdf"], to: "tom@x.example" } })
    );
    expect(facts.find((fact) => fact.key === "attachments")?.value).toBe(
      "survey.pdf"
    );
  });

  it("names WHO staged it in words, never a kind badge", () => {
    expect(stagedEyebrow(outbox(), NOW)).toBe(
      "Outbound email · staged by the assistant · staged 19 minutes ago"
    );
    expect(callerPhrase("app", "Photos")).toBe("the app Photos");
    expect(callerPhrase("agent", "Tidy downloads")).toBe(
      "the automation Tidy downloads"
    );
    expect(callerPhrase("owner-device", null)).toBe("owner-device");
    expect(
      outboundLabel({ connection: { kind: "smb" }, verb: "put_file" })
    ).toBe("Outbound write");
  });
});

describe("the queue", () => {
  it("counts everything that demands something, and nothing that reports", () => {
    const data = {
      decisions: {
        count: 2,
        needsAuth: [
          {
            attentionAt: "2026-08-09T00:00:00.000Z",
            connectionId: "c-1",
            kind: "gmail",
            label: "Gmail",
            note: null,
          },
        ],
        outbox: [outbox()],
        parked: [],
        scopeRequests: [],
      },
      notices: [notice(), notice({ noticeId: "n-2", severity: "info" })],
      unreadNoticeCount: 2,
    };
    expect(waitingTotal(data)).toBe(3);
    expect(isAttention(notice({ severity: "info" }))).toBe(false);
    expect(
      isAttention(notice({ archivedAt: "2026-08-13T09:00:00.000Z" }))
    ).toBe(false);
  });

  it("states what is on screen when a filter hides part of it", () => {
    expect(waitingMeta(3, 12)).toBe("showing 3 of 12");
    expect(waitingMeta(12, 12)).toBe("12 waiting");
  });

  it("earns its chips only when the queue outgrows them", () => {
    expect(opsStateFor("ready", 0)).toBe("empty");
    expect(opsStateFor("ready", 4)).toBe("ready");
    expect(opsStateFor("ready", 5)).toBe("full");
    expect(opsStateFor("loading", 0)).toBe("loading");
    expect(opsStateFor("error", 9)).toBe("error");
  });

  it("gives each waiting item exactly one chip", () => {
    expect(outboxRowCopy(outbox(), NOW).kind).toBe("staged");
    expect(
      needsAuthRowCopy({
        connectionId: "c-1",
        kind: "gmail",
        label: "Gmail",
        note: null,
      }).kind
    ).toBe("auth");
    expect(
      parkedRowCopy(
        {
          caller: "Tidy downloads",
          callerKind: "agent",
          command: "delete_files",
          input: {},
          invocationId: "i-1",
          parkedAt: "2026-08-13T08:00:00.000Z",
        },
        NOW,
        false
      ).kind
    ).toBe("risk");
    expect(
      scopeRowCopy(
        {
          appId: "Weekly digest",
          purpose: "read your calendar",
          requestId: "r-1",
          requestedAt: "2026-08-12T08:00:00.000Z",
          scopes: [{ schema: "calendar", table: "events", verbs: "read" }],
        },
        NOW,
        false
      ).kind
    ).toBe("auth");
    expect(noticeRowCopy(notice(), NOW).kind).toBe("risk");
    expect(matchesFilter("all", "risk")).toBe(true);
    expect(matchesFilter("staged", "risk")).toBe(false);
  });

  it("colours only what has failed, and only its metadata", () => {
    expect(outboxRowCopy(outbox(), NOW).net).toBe(false);
    expect(
      needsAuthRowCopy({
        connectionId: "c-1",
        kind: "gmail",
        label: "Gmail",
        note: null,
      }).net
    ).toBe(true);
    expect(noticeRowCopy(notice({ severity: "high" }), NOW).net).toBe(true);
    expect(noticeRowCopy(notice({ severity: "warning" }), NOW).net).toBe(false);
  });

  it("says where a reconnection finishes, on the row that starts it", () => {
    expect(
      needsAuthRowCopy({
        connectionId: "c-1",
        kind: "gmail",
        label: "Gmail",
        note: "The connection lapsed",
      }).sub
    ).toBe(
      "The connection lapsed · Opens a secure browser inside Centraid — stay here until it closes."
    );
  });

  it("turns severity into a word, and gives an FYI none", () => {
    expect(noticeSeverityLabel("automation-failed", "high")).toBe("Failed");
    expect(noticeSeverityLabel("gateway-health", "warning")).toBe("Degraded");
    expect(noticeSeverityLabel("automation-failed", "info")).toBe("");
  });

  it("tells a long failure as a span, and a short one as a count", () => {
    expect(noticeSpanPhrase(notice({ count: 1 }))).toBeUndefined();
    expect(
      noticeSpanPhrase(
        notice({
          count: 6,
          firstAt: "2026-08-07T08:00:00.000Z",
          lastAt: "2026-08-13T08:00:00.000Z",
        })
      )
    ).toBe("failing for 6 days");
    expect(noticeSpanPhrase(notice({ count: 6 }))).toBe("×6 over 30 minutes");
    // An unreadable or non-advancing pair states the multiplicity only —
    // never an invented duration.
    expect(noticeSpanPhrase(notice({ count: 6, lastAt: "nonsense" }))).toBe(
      "×6"
    );
  });

  it("dates things the way a member would say them", () => {
    expect(agoPhrase(NOW, NOW)).toBe("just now");
    expect(agoPhrase(NOW - 3 * 60_000, NOW)).toBe("3 minutes ago");
    expect(agoPhrase(NOW - 2 * 3_600_000, NOW)).toBe("2 hours ago");
  });
});

describe("the standing line and the reference tail", () => {
  it("states the count and that nothing has happened yet", () => {
    const copy = approvalsHealth(3);
    expect(copy.label).toBe("3 items waiting on you");
    expect(copy.detail).toBe(
      "Nothing here has happened yet. Approving is the act."
    );
    // No inline verb, ever: the page's whole content IS the thing to act on.
    expect(copy.action).toBeUndefined();
    expect(copy.emptyText).toBe(
      "Nothing to attend to · nothing needs you here right now."
    );
    expect(copy.errorText).toBe(
      "This page could not load · everything else on the gateway is unaffected."
    );
    expect(copy.loadingText).toBe("Reading from the gateway");
  });

  it("keeps the verbatim rule sentences", () => {
    expect(DENY_TITLE).toBe("Deny this write");
    expect(DENY_SUB).toBe(
      "Nothing is sent. The automation is told it was refused, and remembers."
    );
    expect(GRANTS_NOTE).toBe(
      "A standing grant skips this page for one narrow thing. Revoking one takes effect on the next run."
    );
    expect(EMPTY_BODY).toBe(
      "Staged writes, lapsed connections and requests for wider access appear here. This page is empty most of the time, and that is the healthy state."
    );
    expect(LOADING_NOTE).toBe(
      "A row knows its shape before its content arrives, so nothing reflows when it does."
    );
  });

  it("words a grant as the standing permission it is", () => {
    const copy = grantRowCopy(
      {
        actor: "Photos",
        actorId: "app:photos",
        createdAt: "2026-08-13T08:00:00.000Z",
        grantId: "g-1",
        revokedAt: null,
        target: "ana@pemberton.example",
        verb: "share",
      },
      NOW
    );
    expect(copy.title).toBe("Photos may always share");
    expect(copy.sub).toBe("share → ana@pemberton.example");
    expect(copy.meta).toBe("granted 1 hour ago");
  });
});
