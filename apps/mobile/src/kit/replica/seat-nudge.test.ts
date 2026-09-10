// The seat nudge (#1011 M2): one catch-up asked for, never a loop.
import { describe, expect, it, vi } from "vitest";

import { nudgeSeatCatchUp } from "./seat-nudge";

describe(nudgeSeatCatchUp, () => {
  it("asks the open session to pull, exactly once", async () => {
    const pullNow = vi.fn<() => Promise<boolean>>(() => Promise.resolve(true));
    await expect(nudgeSeatCatchUp({ session: { pullNow } })).resolves.toBe(
      true
    );
    expect(pullNow).toHaveBeenCalledOnce();
  });

  it("says false — never throws — when there is no session to ask", async () => {
    await expect(nudgeSeatCatchUp({})).resolves.toBe(false);
  });

  it("passes a refusal through: a catch-up that did not land is not an error", async () => {
    await expect(
      nudgeSeatCatchUp({ session: { pullNow: () => Promise.resolve(false) } })
    ).resolves.toBe(false);
  });
});
