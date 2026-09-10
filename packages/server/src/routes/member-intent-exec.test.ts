/*
 * THE MEMBER WRITE DOOR'S DEDUPE TABLE (#1014, V8).
 *
 * Only `executed` used to be a dedupe hit, so a retry against a retained
 * `parked` row re-invoked the command: a SECOND confirmation for the same
 * intent landed in the owner's queue, and approving both applied the write
 * twice. Red-first on the tree before this: every case below except the
 * first answered `undefined` and fell through to `gateway.invoke`.
 */

import { describe, expect, test } from "vitest";

import type { ReplicaIntentOutcome } from "@centraid/vault";

import { retainedPeerAnswer } from "./member-intent-exec.js";

function outcome(
  patch: Partial<ReplicaIntentOutcome> & {
    status: ReplicaIntentOutcome["status"];
  }
): ReplicaIntentOutcome {
  return {
    intentId: "intent-1",
    deviceId: "peer:vlt_member",
    appId: "planner",
    action: "add_task",
    payloadHash: "a".repeat(64),
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...patch,
  };
}

describe("a retained outcome on the member write door", () => {
  test("executed answers with the origin's commit position", () => {
    expect(
      retainedPeerAnswer(outcome({ status: "executed", commitSeq: 12 }), "Ada")
    ).toStrictEqual({
      status: 200,
      body: { state: "executed", intentId: "intent-1", commitSeq: 12 },
    });
  });

  test("parked answers with the wait it already has, and never re-invokes", () => {
    expect(
      retainedPeerAnswer(
        outcome({
          status: "parked",
          reason: "waiting for Ada to confirm",
          waitingOn: { seat: "owner", label: "Ada" },
        }),
        "Ada"
      )
    ).toStrictEqual({
      status: 202,
      body: {
        state: "parked",
        intentId: "intent-1",
        reason: "waiting for Ada to confirm",
        waitingOn: { seat: "owner", label: "Ada" },
      },
    });
  });

  test.each(["denied", "failed", "conflict"] as const)(
    "%s is settled: the remedy is a new id, not another execution",
    (status) => {
      expect(
        retainedPeerAnswer(outcome({ status, reason: "no" }), "Ada")
      ).toStrictEqual({
        status: 200,
        body: { state: "denied", intentId: "intent-1", reason: "no" },
      });
    }
  );

  test("sending re-enters, because the row died before its outcome", () => {
    expect(
      retainedPeerAnswer(outcome({ status: "sending" }), "Ada")
    ).toBeUndefined();
  });

  test("an id this member has never used re-enters", () => {
    expect(retainedPeerAnswer(undefined, "Ada")).toBeUndefined();
  });
});
