import { describe, expect, it } from "vitest";

import { nativeGrantIntentQueue } from "./grant-queue-store";

function storage(initial: Record<string, string> = {}) {
  const cells = { ...initial };
  return {
    cells,
    getItem: (key: string) => Promise.resolve(cells[key] ?? null),
    setItem: (key: string, value: string) => {
      cells[key] = value;
      return Promise.resolve();
    },
  };
}

const intent = (intentId: string, op: "create" | "revoke" = "create") => ({
  intentId,
  queuedAt: "2026-08-28T00:00:00.000Z",
  op,
  ...(op === "revoke" ? { grantId: "g1" } : {}),
});

describe("the native seat's grant queue", () => {
  it("survives a relaunch with its order intact", async () => {
    const disk = storage();
    const before = nativeGrantIntentQueue(disk);
    await before.append(intent("a", "revoke"));
    await before.append(intent("b"));

    const after = nativeGrantIntentQueue(disk);
    expect((await after.list()).map((held) => held.intentId)).toStrictEqual([
      "a",
      "b",
    ]);
    expect((await after.list())[0]!.op).toBe("revoke");
  });

  it("removes only the intent that landed", async () => {
    const queue = nativeGrantIntentQueue(storage());
    await queue.append(intent("a"));
    await queue.append(intent("b"));
    await queue.remove("a");
    expect((await queue.list()).map((held) => held.intentId)).toStrictEqual([
      "b",
    ]);
  });

  it("drops a value it cannot trust rather than half-reading it", async () => {
    const corrupt = storage({ "centraid.grant-queue.v1": "{not json" });
    await expect(nativeGrantIntentQueue(corrupt).list()).resolves.toStrictEqual(
      []
    );
    const drifted = storage({
      "centraid.grant-queue.v1": JSON.stringify([
        { intentId: "a", op: "create", queuedAt: "x" },
        { op: "wat" },
        null,
      ]),
    });
    expect(
      (await nativeGrantIntentQueue(drifted).list()).map(
        (held) => held.intentId
      )
    ).toStrictEqual(["a"]);
  });
});
