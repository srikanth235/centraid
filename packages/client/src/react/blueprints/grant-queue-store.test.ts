// The queue's law is tested in `@centraid/blueprints`; this seat pins
// durability and order.

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { openGrantIntentQueue } from "./grant-queue-store.js";

const intent = (intentId: string, op: "create" | "revoke" = "create") => ({
  intentId,
  queuedAt: "2026-08-28T00:00:00.000Z",
  op,
  ...(op === "revoke" ? { grantId: "g1" } : {}),
});

describe("the browser seat's grant queue", () => {
  it("survives a reload with its order intact", async () => {
    const factory = new IDBFactory();
    const first = (await openGrantIntentQueue(factory))!;
    await first.append(intent("a", "revoke"));
    await first.append(intent("b"));
    await first.append(intent("c"));

    const second = (await openGrantIntentQueue(factory))!;
    expect((await second.list()).map((held) => held.intentId)).toStrictEqual([
      "a",
      "b",
      "c",
    ]);
    expect((await second.list())[0]!.op).toBe("revoke");
  });

  it("removes the intent that landed and leaves the rest in place", async () => {
    const factory = new IDBFactory();
    const queue = (await openGrantIntentQueue(factory))!;
    await queue.append(intent("a"));
    await queue.append(intent("b"));
    await queue.remove("a");
    expect((await queue.list()).map((held) => held.intentId)).toStrictEqual([
      "b",
    ]);
    // Not an error: a drain may race a reload.
    await expect(queue.remove("gone")).resolves.toBeUndefined();
  });

  it("answers undefined where nothing durable can hold an intent", async () => {
    // Never a silent in-memory queue: a store that forgets on reload must not
    // tell a member their share is on its way.
    await expect(openGrantIntentQueue(undefined)).resolves.toBeUndefined();
  });
});
