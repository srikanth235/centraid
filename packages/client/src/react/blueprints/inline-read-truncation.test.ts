/**
 * THE WEB SEAT'S READ BOUNDARY (#922 0a).
 *
 * `ctx.vault.read` is where every blueprint query reaches the replica, so it is
 * where an undeclared window is refused and where a filled one is spoken aloud.
 * Both halves are asserted here: the refusal names the entity and the fix, and a
 * truncated answer reaches the one status line without the query doing anything.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { truncatedListNotice } from "@centraid/blueprints/apps/_shared/shared-copy";

import { OnlineOnlyGuard } from "../../replica/errors.js";
import type { ShellReplicaReadRequest } from "../../replica/shell-session.js";
import type {
  ReplicaReadWireResult,
  ReplicaSearchWireResult,
} from "../../replica/types.js";
import { readStatus, resetStatus } from "../../status-channel.js";
import { buildInlineCtx } from "./inlineQueryCtx.js";
import type { InlineReplicaSession } from "./inlineQueryCtx.js";

const cursor = { epoch: "e1", seq: 3 };

function session(
  answer: Partial<ReplicaReadWireResult> = {}
): InlineReplicaSession & { requests: ShellReplicaReadRequest[] } {
  const requests: ShellReplicaReadRequest[] = [];
  return {
    requests,
    async read(_appId, request): Promise<ReplicaReadWireResult> {
      requests.push(request);
      return {
        rows: [],
        cursor,
        dependency: { shapeId: "s", entity: request.entity },
        ...answer,
      };
    },
    async search(): Promise<ReplicaSearchWireResult> {
      return { rows: [], cursor, dependency: { shapeId: "s", entity: "x" } };
    },
  };
}

function vaultOf(replica: InlineReplicaSession): {
  read: (request: ShellReplicaReadRequest) => Promise<{ rows: unknown[] }>;
} {
  return (
    buildInlineCtx(
      { session: replica, appId: "people" },
      new OnlineOnlyGuard()
    ) as {
      vault: {
        read: (
          request: ShellReplicaReadRequest
        ) => Promise<{ rows: unknown[] }>;
      };
    }
  ).vault;
}

describe("inline read boundary", () => {
  beforeEach(() => {
    resetStatus();
  });

  it("refuses a read that declares no window and accepts no truncation", async () => {
    const replica = session();
    await expect(
      vaultOf(replica).read({ entity: "core.party" })
    ).rejects.toThrow(/core\.party/u);
    // Refused BEFORE the read: a silently capped page never existed.
    expect(replica.requests).toHaveLength(0);
  });

  it("names both ways out, so the message is the work order", async () => {
    const refusal: Error & { code?: string } = await vaultOf(session())
      .read({ entity: "core.party" })
      .then(() => {
        throw new Error("the unbounded read was answered, not refused");
      })
      .catch((error: unknown) => error as Error & { code?: string });
    expect(refusal.code).toBe("UNBOUNDED_READ");
    expect(refusal.message).toContain("limit");
    expect(refusal.message).toContain("acceptTruncation");
  });

  it("admits a declared window and an accepted default alike", async () => {
    const replica = session();
    await vaultOf(replica).read({ entity: "core.party", limit: 5000 });
    await vaultOf(replica).read({
      entity: "core.party",
      acceptTruncation: true,
    });
    expect(replica.requests).toHaveLength(2);
  });

  it("says the truncation out loud on the one status line", async () => {
    const replica = session({ truncated: true, appliedLimit: 1000 });
    await vaultOf(replica).read({
      entity: "core.party",
      acceptTruncation: true,
    });
    expect(readStatus()?.text).toBe(truncatedListNotice(1000));
  });

  it("stays quiet when the window cut nothing off", async () => {
    await vaultOf(session()).read({
      entity: "core.party",
      acceptTruncation: true,
    });
    expect(readStatus()).toBeNull();
  });
});
