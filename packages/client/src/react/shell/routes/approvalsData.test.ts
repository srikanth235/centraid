import { describe, expect, it } from "vitest";

import type {
  OutboxGrant,
  OutboxItem,
  OutboxNeedsAuth,
  OutboxScopeRequest,
  ReviewEntry,
} from "../../../gateway-client-outbox.js";
import type { VaultParkedEntry } from "../../../gateway-client-vault.js";
import {
  APPROVALS_FULL_AT,
  approvalsCountLine,
  approvalsHealth,
  approvalsState,
  buildEnrichConsentRow,
  buildGrantRow,
  buildActivityRow,
  collapseAdjacentActivity,
  formatActivityDetail,
  humanizeActivityLabel,
  truncateObjectId,
  buildNeedsAuthRow,
  buildOutboxRow,
  buildParkedRow,
  buildScopeRequestRow,
} from "./approvalsData.js";

function reviewEntry(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    receiptId: "receipt-1",
    action: "act sync.remove_connection",
    objectType: "agent.command",
    objectId: "cmd-abc123def456",
    decision: "allow",
    occurredAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    risk: null,
    invocationId: "inv-1",
    actorId: "agent-1",
    actorKind: "agent",
    actor: "gmail-send",
    grantId: null,
    context: null,
    ...overrides,
  };
}

function outboxItem(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    itemId: "item1",
    actorId: "agent1",
    connection: { kind: "pull.gmail", label: "personal" },
    actor: "gmail-send",
    actorKind: "agent",
    verb: "gmail.send",
    target: "ravi@example.com",
    artifact: { to: "ravi@example.com", subject: "Hi", body: "See you at 6." },
    status: "pending",
    grantId: null,
    stagedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    decidedAt: null,
    drainedAt: null,
    result: null,
    note: null,
    canEdit: false,
    ...overrides,
  };
}

describe(buildOutboxRow, () => {
  it("reads a plain-string recipient + subject/body straight off the artifact", () => {
    const row = buildOutboxRow(outboxItem());
    expect(row.recipient).toBe("ravi@example.com");
    expect(row.subject).toBe("Hi");
    expect(row.bodyPreview).toBe("See you at 6.");
    expect(row.connectionLabel).toBe("personal");
    expect(row.fields).toStrictEqual(
      expect.arrayContaining([
        { key: "to", label: "To", value: "ravi@example.com" },
        { key: "subject", label: "Subject", value: "Hi" },
        { key: "body", label: "Body", value: "See you at 6." },
      ])
    );
    expect(row.canEdit).toBe(false);
    expect(row.artifact).toStrictEqual({
      to: "ravi@example.com",
      subject: "Hi",
      body: "See you at 6.",
    });
    expect(row.caller).toBe("gmail-send");
    expect(row.callerKind).toBe("agent");
  });

  it("falls back to the actor kind when the actor display name is null", () => {
    const row = buildOutboxRow(outboxItem({ actor: null, actorKind: "app" }));
    expect(row.caller).toBe("app");
    expect(row.callerKind).toBe("app");
  });

  it("carries `canEdit` through from the wire item", () => {
    const row = buildOutboxRow(outboxItem({ canEdit: true }));
    expect(row.canEdit).toBe(true);
  });

  it("joins a list of recipients — the real gmail-send template stages `to` as an array", () => {
    const row = buildOutboxRow(
      outboxItem({
        artifact: { to: ["a@x.com", "b@x.com"], subject: "Hi", body: "Hey" },
      })
    );
    expect(row.recipient).toBe("a@x.com, b@x.com");
  });

  it("falls back to the target when the artifact has no `to`", () => {
    const row = buildOutboxRow(
      outboxItem({ artifact: { payload: "x" }, target: "acct-9" })
    );
    expect(row.recipient).toBe("acct-9");
    expect(row.subject).toBeNull();
  });

  it("truncates a long body for the preview", () => {
    const long = "x".repeat(200);
    const row = buildOutboxRow(
      outboxItem({ artifact: { to: "a@x.com", body: long } })
    );
    expect(row.bodyPreview?.endsWith("…")).toBe(true);
    expect(row.bodyPreview?.length).toBe(161);
  });
});

describe(buildNeedsAuthRow, () => {
  it("carries the connection health note through unchanged", () => {
    const row: OutboxNeedsAuth = {
      connectionId: "c1",
      kind: "pull.gmail",
      label: "personal",
      note: "token expired",
      attentionAt: "2026-07-30T10:00:00.000Z",
    };
    expect(buildNeedsAuthRow(row)).toStrictEqual({
      connectionId: "c1",
      kind: "pull.gmail",
      label: "personal",
      note: "token expired",
    });
  });
});

describe(buildParkedRow, () => {
  it("falls back to the caller kind when the caller name is null", () => {
    const row: VaultParkedEntry = {
      invocationId: "inv1",
      command: "social.send_message",
      parkedAt: new Date().toISOString(),
      callerKind: "app",
      callerId: "app-1",
      caller: null,
      input: { to: "x" },
    };
    const out = buildParkedRow(row);
    expect(out.caller).toBe("app");
    expect(out.callerKind).toBe("app");
    expect(out.inputPreview).toContain('"to"');
  });

  it("carries the assistant caller kind through for the Approvals badge", () => {
    const row: VaultParkedEntry = {
      invocationId: "inv2",
      command: "locker.purge_item",
      parkedAt: new Date().toISOString(),
      callerKind: "assistant",
      callerId: "agent-1",
      caller: "Assistant",
      input: {},
    };
    const out = buildParkedRow(row);
    expect(out.caller).toBe("Assistant");
    expect(out.callerKind).toBe("assistant");
  });
});

describe(buildScopeRequestRow, () => {
  it('summarizes scopes as "schema.table (verbs)"', () => {
    const row: OutboxScopeRequest = {
      requestId: "r1",
      plane: "app",
      appId: "invoicer",
      purpose: "dpv:ServiceProvision",
      scopes: [
        { schema: "core", verbs: "read" },
        { schema: "schedule", table: "task", verbs: "act" },
      ],
      requestedAt: new Date().toISOString(),
    };
    expect(buildScopeRequestRow(row).scopeSummary).toBe(
      "core (read), schedule.task (act)"
    );
  });
});

describe(buildGrantRow, () => {
  it("falls back to the actor id when the resolved name is null", () => {
    const row: OutboxGrant = {
      grantId: "g1",
      actor: null,
      actorId: "app-42",
      verb: "gmail.send",
      target: "ravi@example.com",
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    expect(buildGrantRow(row).actorLabel).toBe("app-42");
  });
});

describe(humanizeActivityLabel, () => {
  it("preserves Locker fill / reveal copy unchanged", () => {
    expect(
      humanizeActivityLabel("reveal", "allow", "locker.item", {
        kind: "fill",
        origin: "https://example.test",
      })
    ).toBe("Locker filled a login");
    expect(humanizeActivityLabel("reveal", "deny", "locker.item", null)).toBe(
      "Locker reveal denied"
    );
  });

  it("sentence-cases unmapped act verbs (strips act prefix)", () => {
    expect(
      humanizeActivityLabel(
        "act sync.remove_connection",
        "allow",
        "agent.command",
        null
      )
    ).toBe("Sync remove connection");
    expect(
      humanizeActivityLabel(
        "act consent.app_ext_draft_drop",
        "deny",
        "agent.command",
        null
      )
    ).toBe("Consent app ext draft drop");
  });
});

describe("formatActivityDetail / truncateObjectId", () => {
  it("formats objectType · truncated objectId when an id is present", () => {
    expect(
      formatActivityDetail("agent.command", "cmd-abc123def456", null, "act x")
    ).toBe(`agent.command · ${truncateObjectId("cmd-abc123def456")}`);
    expect(truncateObjectId("short")).toBe("short");
    expect(truncateObjectId("abcdefghijklmnop", 8).endsWith("…")).toBe(true);
  });

  it("uses fill origin for Locker fill rows", () => {
    expect(
      formatActivityDetail(
        "locker.item",
        "login-1",
        { kind: "fill", origin: "https://example.test" },
        "reveal"
      )
    ).toBe("https://example.test");
  });
});

describe(buildActivityRow, () => {
  it("turns a Locker reveal into an origin-bearing fill activity row", () => {
    const row = reviewEntry({
      receiptId: "receipt-fill",
      action: "reveal",
      objectType: "locker.item",
      objectId: "login-1",
      decision: "allow",
      actorId: null,
      actorKind: null,
      actor: null,
      context: { kind: "fill", origin: "https://example.test" },
    });
    expect(buildActivityRow(row)).toMatchObject({
      label: "Locker filled a login",
      detail: "https://example.test",
      decision: "allow",
      attribution: "owner",
      count: 1,
    });
  });

  it("does not mislabel a manual Locker reveal as an autofill", () => {
    const row = reviewEntry({
      receiptId: "receipt-manual",
      action: "reveal",
      objectType: "locker.item",
      objectId: "login-1",
      decision: "allow",
      actorId: null,
      actorKind: null,
      actor: null,
      context: null,
    });
    expect(buildActivityRow(row)).toMatchObject({
      label: "Locker login revealed",
      detail: `locker.item · ${truncateObjectId("login-1")}`,
    });
  });

  it("labels a denied fill without claiming a credential was filled", () => {
    const row = reviewEntry({
      receiptId: "receipt-denied",
      action: "reveal",
      objectType: "locker.item",
      objectId: "login-1",
      decision: "deny",
      actorId: null,
      actorKind: null,
      actor: null,
      context: { kind: "fill", origin: "https://example.test" },
    });
    expect(buildActivityRow(row)).toMatchObject({
      label: "Locker fill denied",
      detail: "https://example.test",
      attribution: null,
    });
  });

  it("carries risk, actor, grant attribution, absolute time, and object fields", () => {
    const occurredAt = "2026-03-01T12:00:00.000Z";
    const row = buildActivityRow(
      reviewEntry({
        risk: "high",
        actorKind: "assistant",
        actor: "Assistant",
        grantId: "grant-9",
        decision: "allow",
        occurredAt,
        objectId: "obj-1",
        objectType: "agent.command",
      })
    );
    expect(row).toMatchObject({
      risk: "high",
      actor: "Assistant",
      actorKind: "assistant",
      grantId: "grant-9",
      attribution: "grant",
      objectId: "obj-1",
      objectType: "agent.command",
      occurredAt,
      label: "Sync remove connection",
    });
    expect(row.detail).toContain("agent.command");
    expect(row.detail).toContain(truncateObjectId("obj-1"));
  });

  it("attributes owner approval when allow has no standing grant", () => {
    expect(
      buildActivityRow(reviewEntry({ grantId: null, decision: "allow" }))
        .attribution
    ).toBe("owner");
  });

  it("handles null actorId / actorKind without inventing values", () => {
    const row = buildActivityRow(
      reviewEntry({
        actorId: null,
        actorKind: null,
        actor: null,
        decision: "deny",
      })
    );
    expect(row.actor).toBeNull();
    expect(row.actorKind).toBeNull();
    expect(row.attribution).toBeNull();
  });
});

describe(collapseAdjacentActivity, () => {
  it("collapses adjacent rows with the same verb + object + decision", () => {
    const a = buildActivityRow(
      reviewEntry({ receiptId: "r1", decision: "deny" })
    );
    const b = buildActivityRow(
      reviewEntry({ receiptId: "r2", decision: "deny" })
    );
    const c = buildActivityRow(
      reviewEntry({ receiptId: "r3", decision: "deny" })
    );
    const collapsed = collapseAdjacentActivity([a, b, c]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.count).toBe(3);
    expect(collapsed[0]?.receiptId).toBe("r1");
  });

  it("does not collapse non-adjacent repeats", () => {
    const a = buildActivityRow(
      reviewEntry({ receiptId: "r1", decision: "deny" })
    );
    const mid = buildActivityRow(
      reviewEntry({
        receiptId: "r2",
        decision: "allow",
        action: "act other.thing",
        objectId: "other",
      })
    );
    const c = buildActivityRow(
      reviewEntry({ receiptId: "r3", decision: "deny" })
    );
    const collapsed = collapseAdjacentActivity([a, mid, c]);
    expect(collapsed).toHaveLength(3);
    expect(collapsed.every((r) => r.count === 1)).toBe(true);
  });

  it("does not collapse when decision differs", () => {
    const a = buildActivityRow(
      reviewEntry({ receiptId: "r1", decision: "allow" })
    );
    const b = buildActivityRow(
      reviewEntry({ receiptId: "r2", decision: "deny" })
    );
    expect(collapseAdjacentActivity([a, b])).toHaveLength(2);
  });
});

describe("what the frame says about Notifications", () => {
  it("calls a page with nothing waiting empty, and a long queue full", () => {
    expect(approvalsState({ grants: 2, waiting: 0 })).toBe("empty");
    expect(approvalsState({ grants: 2, waiting: 1 })).toBe("ready");
    expect(approvalsState({ grants: 2, waiting: APPROVALS_FULL_AT })).toBe(
      "ready"
    );
    expect(approvalsState({ grants: 2, waiting: APPROVALS_FULL_AT + 1 })).toBe(
      "full"
    );
  });

  it("counts what is waiting and what is standing, and never says zero", () => {
    expect(approvalsCountLine({ grants: 2, waiting: 3 })).toBe(
      "3 decisions waiting · 2 standing grants"
    );
    expect(approvalsCountLine({ grants: 1, waiting: 1 })).toBe(
      "1 decision waiting · 1 standing grant"
    );
    expect(approvalsCountLine({ grants: 2, waiting: 0 })).toBe(
      "Nothing waiting · 2 standing grants"
    );
  });

  it("says nothing has happened yet, and offers no inline verb", () => {
    const health = approvalsHealth({ grants: 0, waiting: 3 });
    expect(health.label).toBe("3 waiting on you");
    expect(health.detail).toBe(
      "Nothing here has happened yet — approving is the act."
    );
    expect(health).not.toHaveProperty("action");
  });
});

// Egress-consent ledger rows (#807).
describe(buildEnrichConsentRow, () => {
  it("reads an answer back as one line, refusals stated as plainly as grants", () => {
    const declined = buildEnrichConsentRow({
      capability: "faces",
      egress: "provider",
      scopeRef: "",
      decision: "declined",
      decidedAt: "2026-08-15T10:00:00.000Z",
      receiptId: null,
    });

    expect(declined.id).toBe("faces:provider:");
    expect(declined.title).toBe("Faces");
    expect(declined.meta).toBe("provider");
    expect(declined.sub).toContain("Declined");
    expect(declined.sub).toContain("at a third-party provider");
    expect(declined.sub).toContain("this vault");
  });

  it("names the scope an answer was given for, when it was not the whole vault", () => {
    const scoped = buildEnrichConsentRow({
      capability: "doc-text",
      egress: "on-device",
      scopeRef: "album-7",
      decision: "granted",
      decidedAt: "2026-08-15T10:00:00.000Z",
      receiptId: "receipt-1",
    });

    expect(scoped.id).toBe("doc-text:on-device:album-7");
    expect(scoped.title).toBe("Doc text");
    expect(scoped.sub).toContain("Granted");
    expect(scoped.sub).toContain("on this device");
    expect(scoped.sub).toContain("album-7");
  });
});
