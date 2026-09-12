/*
 * GMAIL'S RUN STATE AND PAGE BOUNDS (#1014, B14/B15).
 *
 * `observedProfile` lived in a module-level `let`, and the worker reuses a
 * module across fires, connections and VAULTS — so one mailbox's `historyId`
 * became another's watermark and every message between the two was skipped
 * silently. The listing loops were unbounded `do…while (pageToken)` walks with
 * an all-or-nothing return, so a large mailbox never converged.
 *
 * Its own file rather than an addition to `pull-connectors-graph.test.ts`:
 * that one is already at the repo's 625-line ceiling.
 */

import { describe, expect, it } from "vitest";

import { cursorHarness, json, loadPull } from "./handler-harness.js";
import type { FetchCall, FetchReply } from "./handler-harness.js";

function pullCtx(route: (call: FetchCall) => FetchReply): {
  ctx: Record<string, unknown>;
  log: { info: (message: string) => void; warn: (message: string) => void };
  fetches: FetchCall[];
} {
  const fetches: FetchCall[] = [];
  return {
    ctx: {
      now: "2026-09-10T00:00:00.000Z",
      fetch: (call: FetchCall) => {
        fetches.push(call);
        return Promise.resolve(route(call));
      },
    },
    log: { info: () => undefined, warn: () => undefined },
    fetches,
  };
}

describe("google-gmail-pull state and page bounds", () => {
  it("carries the observed profile per run, never across modules", async () => {
    const spec = await loadPull("google-gmail-pull", { fresh: true });
    // The module is loaded ONCE and driven twice, exactly as the worker's
    // module cache does: mailbox two must not inherit mailbox one's watermark.
    const first = pullCtx(({ url }) =>
      url.endsWith("/profile")
        ? json({ emailAddress: "one@example.com", historyId: "111" })
        : json({ messages: [] })
    );
    await spec.principal({ ctx: first.ctx });
    const firstHarness = cursorHarness({});
    await spec.pull({
      ctx: first.ctx,
      cursor: firstHarness.cursor,
      log: first.log,
    });
    expect(firstHarness.updates.get("gmail.historyId")).toBe("111");

    const second = pullCtx(({ url }) =>
      url.endsWith("/profile")
        ? json({ emailAddress: "two@example.com", historyId: "222" })
        : json({ messages: [] })
    );
    await spec.principal({ ctx: second.ctx });
    const secondHarness = cursorHarness({});
    await spec.pull({
      ctx: second.ctx,
      cursor: secondHarness.cursor,
      log: second.log,
    });
    expect(secondHarness.updates.get("gmail.historyId")).toBe("222");

    // A pull whose principal probe never ran carries no other mailbox's
    // profile: it refuses instead of inventing a watermark.
    const stray = pullCtx(() => json({ messages: [] }));
    await expect(
      spec.pull({
        ctx: stray.ctx,
        cursor: cursorHarness({}).cursor,
        log: stray.log,
      })
    ).rejects.toThrow(/principal probe/u);
  });

  it("bounds the window walk and resumes from the saved page token", async () => {
    const spec = await loadPull("google-gmail-pull", { fresh: true });
    let listings = 0;
    const { ctx, log } = pullCtx(({ url }) => {
      if (url.endsWith("/profile"))
        return json({ emailAddress: "owner@example.com", historyId: "900" });
      if (url.includes("/messages?")) {
        listings += 1;
        // An inexhaustible mailbox: every page offers another.
        return json({ messages: [], nextPageToken: `p${listings}` });
      }
      return json({});
    });
    await spec.principal({ ctx });
    const harness = cursorHarness({});
    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    // Bounded, and honest that it is not finished.
    expect(listings).toBe(8);
    expect(result.summary).toContain("more pages pending");
    // The watermark does NOT advance over an undrained listing…
    expect(harness.updates.has("gmail.historyId")).toBe(false);
    // …and the next fire continues instead of restarting.
    expect(harness.updates.get("gmail.pageToken")).toBe("p8");
  });
});
