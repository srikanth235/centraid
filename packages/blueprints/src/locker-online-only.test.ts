import { describe, expect, it } from "vitest";

import {
  addItemWrite,
  editItemWrite,
  ONLINE_ONLY_ACTIONS,
  starWrite,
} from "../apps/locker/writes.ts";

/* A secret-bearing payload must never enter the durable offline queue: the
 * queue outlives the session, and the session boundary is what keeps a secret
 * memory-only. The write builders carry that rule; pending-projection.ts's
 * excluded set is pinned to the same list in apps/locker/writes.test.ts. */
describe("locker-online-only", () => {
  it("marks add and edit online-only while leaving metadata actions queueable", () => {
    const draft = {
      type: "login" as const,
      title: "Email",
      tags: "personal",
      alias: "",
      fields: { username: "me@example.test", password: "do-not-persist" },
      allowedKeys: ["username", "password"],
    };
    expect(addItemWrite(draft).onlineOnly).toBe(true);
    expect(editItemWrite({ ...draft, itemId: "item-1" }).onlineOnly).toBe(true);
    expect(starWrite("item-1", false).onlineOnly).toBeUndefined();
    expect(ONLINE_ONLY_ACTIONS).toStrictEqual(["add-item", "edit-item"]);
  });
});
