/*
 * Settings → Access, the one dashboard's data (#883, ruling V-dashboard).
 *
 * The claims are the two the ruling turns on: every principal kind is one lens
 * over ONE table, and an unreadable plane is never drawn as an empty one.
 */

import { describe, expect, it } from "vitest";

import { groupAnswers, loadAccessLens, parseLociBody } from "./access-lens.js";
import type { AccessAnswer, AccessReader } from "./access-lens.js";

function row(values: Record<string, unknown>): Record<string, unknown> {
  return {
    authority_id: "a1",
    principal_kind: "person",
    principal_id: "p1",
    subject_type: "core.document",
    subject_id: "d1",
    verb: "view",
    duration: "standing",
    decision: "granted",
    granted_at: "2026-08-01T00:00:00.000Z",
    revoked_at: null,
    ...values,
  };
}

/**
 * A seat whose page answers by TABLE. `readPages` walks, so a single page with
 * no cursor is the whole set — which is what every fixture here is.
 */
function seatOf(
  byTable: Record<string, Record<string, unknown>[] | (() => never)>,
  asked?: string[]
): AccessReader {
  return {
    page: <Row extends object>(request: {
      query: { name: string; from: string };
    }): Promise<{ rows: Row[] }> => {
      asked?.push(request.query.from);
      const answer = byTable[request.query.from];
      if (typeof answer === "function") answer();
      return Promise.resolve({ rows: (answer ?? []) as Row[] });
    },
  };
}

const REGISTRY = {
  subjects: () =>
    Promise.resolve({
      subjects: [],
      loci: {
        boundary:
          "this device is refused at the door from now on; anything already on it stays on it",
        remote: "their vault is asked to remove its copy",
        local: "nothing here will call it again",
      },
    }),
};

describe("the Access lens", () => {
  it("reads every principal kind out of the one table, through People's scope", async () => {
    const asked: string[] = [];
    const lens = await loadAccessLens(
      seatOf(
        {
          share_authority: [
            row({ authority_id: "a1", principal_kind: "person" }),
            row({ authority_id: "a2", principal_kind: "circle" }),
            row({
              authority_id: "a3",
              principal_kind: "harness",
              subject_type: "enrich.scope",
              subject_id: "",
            }),
            row({
              authority_id: "a4",
              principal_kind: "automation",
              subject_type: "agent.pack",
              subject_id: "media",
              verb: "read",
            }),
          ],
        },
        asked
      ),
      REGISTRY
    );
    // Three reads, one plane: the answers, when each was last used, and what
    // is still waiting on the member (#928).
    expect(asked).toStrictEqual([
      "share_authority",
      "share_authority_use",
      "share_authority_request",
    ]);
    expect(lens.status).toBe("ready");
    if (lens.status !== "ready") return;
    expect(
      lens.groups.map((group) => [group.id, group.answers.length])
    ).toStrictEqual([
      ["audiences", 2],
      ["harnesses", 1],
      ["automations", 1],
    ]);
    // THREE KINDS, THREE GROUPS (#996, R17): a `device` row is no longer one
    // of them, and a seat's reach is the devices screen's answer, not a
    // standing one drawn here.
    expect(lens.groups.map((group) => group.id)).not.toContain("devices");
  });

  // WHEN AN ANSWER WAS LAST USED, AND WHAT IS STILL WAITING (#928). Both ride
  // beside the answers: an unread side table leaves "never used" and no
  // pending question, and never blanks the dashboard.
  it("dates every answer it can, and draws an automation's open ask", async () => {
    const lens = await loadAccessLens(
      seatOf({
        share_authority: [
          row({ authority_id: "a1", principal_kind: "automation" }),
          row({ authority_id: "a2", principal_kind: "automation" }),
        ],
        share_authority_use: [
          { authority_id: "a1", last_used_at: "2026-09-03T06:05:00.000Z" },
        ],
        share_authority_request: [
          {
            request_id: "r1",
            principal_id: "receipts",
            scopes_json: JSON.stringify([
              { schema: "tally", table: "expense", verbs: "read" },
              { schema: "core", verbs: "read" },
            ]),
            requested_at: "2026-09-01T08:00:00.000Z",
            decided_at: null,
          },
          // Decided is an ANSWER next door, not a question here.
          {
            request_id: "r0",
            principal_id: "digest",
            scopes_json: "[]",
            requested_at: "2026-08-01T08:00:00.000Z",
            decided_at: "2026-08-02T08:00:00.000Z",
          },
        ],
      }),
      REGISTRY
    );
    expect(lens.status).toBe("ready");
    if (lens.status !== "ready") return;
    const automations = lens.groups.find((group) => group.id === "automations");
    expect(
      automations?.answers.map((answer) => answer.lastUsedAt)
    ).toStrictEqual(["2026-09-03T06:05:00.000Z", null]);
    expect(lens.requests).toStrictEqual([
      {
        requestId: "r1",
        principalId: "receipts",
        scopes: ["tally.expense · read", "core · read"],
        requestedAt: "2026-09-01T08:00:00.000Z",
      },
    ]);
  });

  it("a use table this seat cannot read leaves every row undated, not absent", async () => {
    const lens = await loadAccessLens(
      seatOf({
        share_authority: [row({ principal_kind: "harness" })],
        share_authority_use: () => {
          throw new Error("not in this replica");
        },
        share_authority_request: () => {
          throw new Error("not in this replica");
        },
      }),
      REGISTRY
    );
    expect(lens.status).toBe("ready");
    if (lens.status !== "ready") return;
    const harnesses = lens.groups.find((group) => group.id === "harnesses");
    expect(harnesses?.answers).toHaveLength(1);
    expect(harnesses?.answers[0]?.lastUsedAt).toBeNull();
    expect(lens.requests).toStrictEqual([]);
  });

  it("an unreadable plane is never an empty one", async () => {
    const lens = await loadAccessLens(
      seatOf({
        share_authority: () => {
          throw new Error("no replica store");
        },
      }),
      REGISTRY
    );
    expect(lens).toStrictEqual({
      status: "unreadable",
      reason: "no replica store",
    });
  });

  it("shows what it could read when the vault's copy is unavailable", async () => {
    const lens = await loadAccessLens(seatOf({ share_authority: [row({})] }), {
      subjects: () => Promise.reject(new Error("out of reach")),
    });
    expect(lens.status).toBe("ready");
    if (lens.status !== "ready") return;
    expect(lens.groups[0]!.answers).toHaveLength(1);
    // No sentence is invented in the vault's place.
    expect(lens.loci).toStrictEqual({});
  });

  it("drops a row it could not describe, and keeps refusals", async () => {
    const lens = await loadAccessLens(
      seatOf({
        share_authority: [
          row({ authority_id: "", principal_kind: "person" }),
          row({ principal_kind: "somebody" }),
          row({ authority_id: "a9", decision: "declined" }),
        ],
      }),
      REGISTRY
    );
    expect(lens.status).toBe("ready");
    if (lens.status !== "ready") return;
    const audiences = lens.groups[0]!.answers;
    expect(audiences).toHaveLength(1);
    // A refusal is an ANSWER, not an absent grant (ruling V-table).
    expect(audiences[0]!.decision).toBe("declined");
  });

  it("a revoked answer is history, not access", () => {
    const answers: AccessAnswer[] = [
      {
        authorityId: "a1",
        principalKind: "person",
        principalId: "p1",
        subjectType: "core.document",
        subjectId: "d1",
        verb: "view",
        decision: "granted",
        duration: "standing",
        expiresAt: null,
        grantedAt: "2026-01-01T00:00:00.000Z",
        revokedAt: "2026-02-01T00:00:00.000Z",
        lastUsedAt: null,
      },
    ];
    expect(groupAnswers(answers)[0]!.answers).toStrictEqual([]);
  });

  it("parses only the loci the wire spoke for", () => {
    expect(
      parseLociBody({ loci: { boundary: "held", nowhere: "x" } })
    ).toStrictEqual({
      boundary: "held",
    });
    expect(parseLociBody({})).toStrictEqual({});
    expect(parseLociBody(null)).toStrictEqual({});
  });
});
