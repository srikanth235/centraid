// @vitest-environment jsdom
// The one feedback channel, and the states that stand in for content. The
// status line's contract is that it is ONE element updated in place — so most
// of these assertions are about what does NOT accumulate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import {
  armConfirm,
  outcomeMessage,
  readFailed,
  runBulk,
  showSkeleton,
  statusLine,
} from "./feedback.js";
import type { CentraidHost } from "./host.js";

function line(): HTMLElement | null {
  return document.body.querySelector(".kit-status-line");
}

function text(): string {
  return line()?.querySelector(".kit-status-line-text")?.textContent ?? "";
}

describe(outcomeMessage, () => {
  it("says where a write went when it did not land now", () => {
    expect(outcomeMessage({ status: "queued" })).toContain(
      "it will sync when the gateway is reachable"
    );
    expect(outcomeMessage({ status: "in-flight", reason: "Held" })).toBe(
      "Held"
    );
    expect(outcomeMessage({ status: "parked" })).toContain("your approval");
  });

  it("does not double the punctuation of an authored refusal message", () => {
    expect(
      outcomeMessage({ status: "failed", predicate: "no room left." })
    ).toBe("The vault refused: no room left.");
    expect(outcomeMessage({ status: "failed", predicate: "size < 10" })).toBe(
      "The vault refused: size < 10."
    );
    expect(outcomeMessage({ status: "failed" })).toBe(
      "The vault refused: a precondition failed."
    );
  });

  it("names the consent that denied, and says nothing about a plain success", () => {
    expect(outcomeMessage({ status: "denied", reason: "no scope" })).toBe(
      "Denied by consent: no scope"
    );
    expect(outcomeMessage({ status: "denied" })).toBe("Denied by consent.");
    expect(outcomeMessage({ status: "executed" })).toBeNull();
    expect(outcomeMessage(undefined)).toBeNull();
  });
});

describe("status line", () => {
  beforeEach(() => {
    useFakeClock();
  });

  afterEach(() => {
    delete (globalThis as { centraid?: CentraidHost }).centraid;
  });

  it("mounts exactly one host and reuses it for every later call", () => {
    statusLine("first");
    statusLine("second");
    expect(document.body.querySelectorAll(".kit-status-line")).toHaveLength(1);
    expect(text()).toBe("second");
  });

  it("reverts to quiet on its own duration, and a newer call owns the timer", () => {
    statusLine("early", { duration: 1000 });
    vi.advanceTimersByTime(500);
    // The older call's pending clear must not wipe this newer message.
    statusLine("later", { duration: 1000 });
    vi.advanceTimersByTime(600);
    expect(text()).toBe("later");
    vi.advanceTimersByTime(500);
    expect(text()).toBe("");
  });

  it("stays up for an explicit clear when the duration is 0", () => {
    const clear = statusLine("sticky", { duration: 0 });
    vi.advanceTimersByTime(60_000);
    expect(text()).toBe("sticky");
    clear();
    expect(text()).toBe("");
  });

  it("renders a determinate track instead of reverting while progress runs", () => {
    statusLine("Importing", { progress: { done: 3, total: 4 } });
    const fill = line()?.querySelector<HTMLElement>(".kit-status-line-fill");
    expect(fill?.style.width).toBe("75%");
    vi.advanceTimersByTime(60_000);
    expect(text()).toBe("Importing");
  });

  it("offers undo only with both a label and a handler, and clears on use", () => {
    statusLine("Deleted", { undoLabel: "Undo" });
    expect(line()?.querySelector(".kit-status-line-action")).toBeNull();

    let undone = 0;
    const undo = (): void => {
      undone += 1;
    };
    statusLine("Deleted", { undoLabel: "Undo", onUndo: undo });
    const action = line()?.querySelector<HTMLButtonElement>(
      ".kit-status-line-action"
    );
    expect(action?.textContent).toBe("Undo");
    action?.click();
    expect(undone).toBe(1);
    expect(text()).toBe("");
  });

  it("asks for a haptic only on an explicit non-neutral tone", () => {
    let success = 0;
    let selection = 0;
    (globalThis as { centraid?: CentraidHost }).centraid = {
      haptic: {
        success: () => {
          success += 1;
        },
        selection: () => {
          selection += 1;
        },
      },
    };
    statusLine("quiet");
    expect(success).toBe(0);
    expect(selection).toBe(0);
    statusLine("done", { tone: "affirm" });
    expect(success).toBe(1);
    statusLine("moved", { tone: "change" });
    statusLine("gone", { tone: "destructive" });
    expect(selection).toBe(2);
  });

  it("survives a host whose haptic bridge throws", () => {
    (globalThis as { centraid?: CentraidHost }).centraid = {
      haptic: {
        success: () => {
          throw new Error("no bridge");
        },
      },
    };
    expect(() => statusLine("done", { tone: "affirm" })).not.toThrow();
    expect(text()).toBe("done");
  });
});

describe("stand-in states", () => {
  it("showSkeleton replaces the container's contents with the asked-for rows", () => {
    const box = document.createElement("div");
    box.innerHTML = "<p>stale</p>";
    showSkeleton(box, 5);
    expect(box.querySelector("p")).toBeNull();
    // The same `.kit-skeleton` rows `_shared/LoadingSkeleton.tsx` renders in
    // React (#799).
    expect(box.querySelectorAll(".kit-skeleton")).toHaveLength(5);
    expect(box.children).toHaveLength(5);
  });

  it("readFailed says the vault is unreachable rather than leaving it blank", () => {
    const banner = document.createElement("div");
    banner.hidden = true;
    readFailed(banner);
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("Couldn’t reach the vault");
    // A missing banner is a no-op, never a throw: an app without one still reads.
    expect(() => readFailed(null)).not.toThrow();
  });
});

describe(armConfirm, () => {
  it("arms on the first click and confirms on the second, restoring the label", () => {
    const btn = document.createElement("button");
    btn.textContent = "Delete";
    expect(armConfirm(btn)).toBe(false);
    expect(btn.textContent).toBe("Sure?");
    expect(armConfirm(btn)).toBe(true);
    expect(btn.textContent).toBe("Delete");
  });

  it("disarms itself after the timeout, so a stale arm cannot be confirmed", () => {
    useFakeClock();
    const btn = document.createElement("button");
    btn.textContent = "Delete";
    armConfirm(btn, { armedLabel: "Really?", timeout: 1000 });
    expect(btn.textContent).toBe("Really?");
    vi.advanceTimersByTime(1000);
    expect(btn.textContent).toBe("Delete");
    expect(armConfirm(btn)).toBe(false);
  });
});

describe(runBulk, () => {
  beforeEach(() => {
    useFakeClock();
  });

  it("runs in order, counts the tally, and narrates the parked remainder", async () => {
    const seen: string[] = [];
    const notices: string[] = [];
    await runBulk(
      ["a", "b", "c"],
      async (id) => {
        seen.push(id);
        return {
          status: id === "c" ? ("parked" as const) : ("executed" as const),
        };
      },
      {
        progress: "Deleting",
        done: "Deleted",
        suffix: " photos",
        notice: (t) => notices.push(t),
      }
    );
    expect(seen).toStrictEqual(["a", "b", "c"]);
    expect(notices.slice(0, 3)).toStrictEqual([
      "Deleting 1 of 3…",
      "Deleting 2 of 3…",
      "Deleting 3 of 3…",
    ]);
    // No failures: the notice is cleared rather than left mid-progress.
    expect(notices.at(-1)).toBe("");
    expect(text()).toBe(
      "Deleted 2 of 3 photos · receipted. 1 waiting for approval."
    );
  });

  it("reports the first failure in the app's own words and still finishes", async () => {
    const notices: string[] = [];
    let afterRuns = 0;
    const after = (): void => {
      afterRuns += 1;
    };
    await runBulk(
      ["a", "b"],
      async (id) => ({
        status: id === "a" ? ("failed" as const) : ("executed" as const),
      }),
      {
        progress: "Moving",
        done: "Moved",
        notice: (t) => notices.push(t),
        friendly: () => "that one is locked",
        after,
      }
    );
    expect(notices.at(-1)).toBe(
      "1 of 2 didn’t go through — that one is locked"
    );
    expect(text()).toBe("Moved 1 of 2 · receipted.");
    expect(afterRuns).toBe(1);
  });
});
