import { describe, expect, it } from "vitest";

import {
  ACCESS_SCOPE,
  groupAnswers,
  loadAccessLens,
  parseLociBody,
} from "./access-lens.js";
import type { AccessAnswer } from "./access-lens.js";

function row(values: Record<string, unknown>): {
  values: Record<string, unknown>;
} {
  return {
    values: {
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
    const asked: unknown[] = [];
    const lens = await loadAccessLens(
      {
        read: (appId, request) => {
          asked.push([appId, request.entity]);
          return Promise.resolve({
            rows: [
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
                principal_kind: "device",
                subject_type: "core.vault",
                subject_id: "",
                verb: "edit",
              }),
            ],
          });
        },
      },
      REGISTRY
    );
    expect(asked).toStrictEqual([[ACCESS_SCOPE, "share.authority"]]);
    expect(lens.status).toBe("ready");
    if (lens.status !== "ready") return;
    expect(
      lens.groups.map((group) => [group.id, group.answers.length])
    ).toStrictEqual([
      ["audiences", 2],
      ["harnesses", 1],
      ["devices", 1],
    ]);
    expect(lens.loci.boundary).toBe(
      "this device is refused at the door from now on; anything already on it stays on it"
    );
  });

  it("an unreadable plane is never an empty one", async () => {
    const lens = await loadAccessLens(
      { read: () => Promise.reject(new Error("no replica store")) },
      REGISTRY
    );
    expect(lens).toStrictEqual({
      status: "unreadable",
      reason: "no replica store",
    });
  });

  it("shows what it could read when the vault's copy is unavailable", async () => {
    const lens = await loadAccessLens(
      { read: () => Promise.resolve({ rows: [row({})] }) },
      { subjects: () => Promise.reject(new Error("out of reach")) }
    );
    expect(lens.status).toBe("ready");
    if (lens.status !== "ready") return;
    expect(lens.groups[0]!.answers).toHaveLength(1);
    expect(lens.loci).toStrictEqual({});
  });

  it("drops a row it could not describe, and keeps refusals", async () => {
    const lens = await loadAccessLens(
      {
        read: () =>
          Promise.resolve({
            rows: [
              row({ authority_id: "", principal_kind: "person" }),
              row({ principal_kind: "somebody" }),
              row({ authority_id: "a9", decision: "declined" }),
            ],
          }),
      },
      REGISTRY
    );
    expect(lens.status).toBe("ready");
    if (lens.status !== "ready") return;
    const audiences = lens.groups[0]!.answers;
    expect(audiences).toHaveLength(1);
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
