/*
 * THE TWO ANSWERS TO A MATCH PROPOSAL (#996, R20(c) / OQ-12).
 *
 * The property under test is what the owner's answer DOES: one temporal
 * `core.link` judgment between two transactions, and nothing else. A merge, a
 * delete or an amount change here would make the member's own statement
 * unreconcilable against their vault, so the command and its relation are
 * pinned rather than left to a reviewer to notice.
 */
import { describe, expect, it } from "vitest";

import acceptMatch from "./accept-match.ts";
import rejectMatch from "./reject-match.ts";

interface Invocation {
  command: string;
  input: Record<string, unknown>;
}

function ctxRecording(calls: Invocation[]): unknown {
  return {
    vault: {
      invoke: (call: Invocation) => {
        calls.push(call);
        return Promise.resolve({ status: "executed", output: {} });
      },
    },
  };
}

const BODY = { left_txn_id: "txn-a", right_txn_id: "txn-b" };

describe("accepting and rejecting a cross-source match", () => {
  it("accepts as one `same-as` edge between the two transactions", async () => {
    const calls: Invocation[] = [];
    const result = (await acceptMatch({
      body: BODY,
      ctx: ctxRecording(calls),
    } as never)) as { status: number };
    expect(result.status).toBe(200);
    expect(calls).toStrictEqual([
      {
        command: "core.link_entities",
        input: {
          from_type: "core.transaction",
          from_id: "txn-a",
          to_type: "core.transaction",
          to_id: "txn-b",
          relation: "same-as",
        },
      },
    ]);
  });

  it("rejects as `distinct-from`, so the proposal cannot come back", async () => {
    const calls: Invocation[] = [];
    await rejectMatch({ body: BODY, ctx: ctxRecording(calls) } as never);
    expect(calls[0]?.command).toBe("core.link_entities");
    expect(calls[0]?.input.relation).toBe("distinct-from");
  });

  it("answers a refusal as an outcome, never as a throw", async () => {
    const ctx = {
      vault: {
        invoke: () => Promise.reject(new Error("no standing answer covers it")),
      },
    };
    const result = (await rejectMatch({ body: BODY, ctx } as never)) as {
      status: number;
      body: { status: string; reason?: string };
    };
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("denied");
    expect(result.body.reason).toBe("no standing answer covers it");
  });

  it("invokes exactly one command — nothing is merged or deleted", async () => {
    const calls: Invocation[] = [];
    await acceptMatch({ body: BODY, ctx: ctxRecording(calls) } as never);
    await rejectMatch({ body: BODY, ctx: ctxRecording(calls) } as never);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.command))).toStrictEqual(
      new Set(["core.link_entities"])
    );
  });
});
