import { describe, expect, it, vi } from "vitest";

import { clearFillMaterial, holdsFillMaterial } from "./credential-gesture.js";
import {
  HostLink,
  HostRefusalError,
  IDLE_CLOSE_MS,
  KNOWN_CODES,
  MAX_ATTEMPTS,
  memberSentence,
  shouldRetry,
} from "./host-link.js";
import type { NativePort } from "./host-link.js";

/** A native port that answers from a script, and records what it was sent. */
function fakePort(
  answer: (frame: Record<string, unknown>, at: number) => unknown
) {
  const sent: Record<string, unknown>[] = [];
  let onMessage: ((message: unknown) => void) | undefined;
  let onDisconnect: (() => void) | undefined;
  let disconnected = 0;
  const port: NativePort = {
    postMessage(message) {
      const frame = message as Record<string, unknown>;
      sent.push(frame);
      const reply = answer(frame, sent.length - 1);
      if (reply === undefined) {
        onDisconnect?.();
        return;
      }
      onMessage?.(reply);
    },
    disconnect() {
      disconnected += 1;
    },
    onMessage: {
      addListener(fn) {
        onMessage = fn;
      },
    },
    onDisconnect: {
      addListener(fn) {
        onDisconnect = fn;
      },
    },
  };
  return {
    port,
    sent,
    get disconnected() {
      return disconnected;
    },
  };
}

function ok(value: unknown, retryable = true) {
  return { t: "ok", value, retryable };
}

describe("the fill's clearing", () => {
  /*
   * THE SEAM §E4 GAP, CLOSED. v0 clears fill material on the message response
   * and nothing tests that it happened; this is that test.
   *
   * The responder snapshots, because that is what `sendResponse` does for real:
   * it structured-clones across a process boundary. So the receiver keeps a
   * copy and the worker's own object is emptied — and BOTH halves are asserted,
   * since a clearing that also emptied the answer would pass a weaker test and
   * break the feature.
   */
  it("hands the value on and leaves nothing behind in this process", async () => {
    const material = {
      value: "hunter2-and-more",
      receipt_id: "receipt-7",
      expires_at_ms: 30_000,
      origin: "https://www.bank.example",
    };
    const fake = fakePort(() => ok(material));
    const link = new HostLink({ connect: () => fake.port, now: () => 0 });

    let received: Record<string, unknown> | undefined;
    await link.fillInto(
      { itemId: "item-1", pageUrl: "https://www.bank.example/sign-in" },
      (value) => {
        received = structuredClone(value) as Record<string, unknown>;
      }
    );

    // THE RECEIVER GOT IT.
    expect(received?.["value"]).toBe("hunter2-and-more");
    expect(received?.["receipt_id"]).toBe("receipt-7");
    // AND THIS PROCESS DID NOT KEEP IT.
    expect(holdsFillMaterial(material)).toBe(false);
    expect(material).not.toHaveProperty("value");
    expect(material).not.toHaveProperty("receipt_id");
    // The non-secret half of the answer is untouched, so a surface can still
    // say when the window closes and which page it was for.
    expect(material.expires_at_ms).toBe(30_000);
    expect(material.origin).toBe("https://www.bank.example");
  });

  it("clears every named field and nothing else", () => {
    const material = {
      value: "v",
      username: "u",
      password: "p",
      totp: "123456",
      receipt_id: "r",
      origin: "https://a.test",
    };
    clearFillMaterial(material);
    expect(Object.keys(material)).toStrictEqual(["origin"]);
  });

  it("drops a save's password whether the save worked or not", async () => {
    const request = {
      t: "locker:save",
      title: "A Login",
      password: "a-long-enough-password",
      pageUrl: "https://www.bank.example",
    };
    const fake = fakePort(() => ({
      t: "error",
      code: "refused",
      message: "no",
    }));
    const link = new HostLink({ connect: () => fake.port, now: () => 0 });
    await expect(link.ask("locker:save", request)).rejects.toBeInstanceOf(
      HostRefusalError
    );
    // The frame the link built is the one that is cleared; the caller's own
    // object is theirs to hold.
    expect(fake.sent[0]).not.toHaveProperty("password");
  });
});

describe("the retry classification", () => {
  /*
   * v0's rule, carried: a revoked device is never retried, and a method that is
   * not idempotent retries only a clear connect failure. What changed is the
   * authority — the HOST says whether anything happened, so its answer wins over
   * the local table.
   */
  it("never repeats a fill the host answered", async () => {
    const fake = fakePort(() => ({
      t: "error",
      code: "locker-origin-mismatch",
      message: "no",
      retryable: false,
    }));
    const link = new HostLink({ connect: () => fake.port, now: () => 0 });
    await expect(
      link.ask("locker:fill", { itemId: "i", pageUrl: "https://a.test" })
    ).rejects.toBeInstanceOf(HostRefusalError);
    expect(fake.sent).toHaveLength(1);
  });

  it("retries an idempotent read that never reached the host", async () => {
    let attempts = 0;
    const fake = fakePort(() => {
      attempts += 1;
      return attempts < 3 ? undefined : ok({ ok: true });
    });
    const link = new HostLink({ connect: () => fake.port, now: () => 0 });
    await expect(link.ask("warm")).resolves.toStrictEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it("stops at the ceiling", () => {
    expect(
      shouldRetry({
        attempt: MAX_ATTEMPTS,
        maxAttempts: MAX_ATTEMPTS,
        method: "warm",
        error: new Error("the port closed"),
      })
    ).toBe(false);
  });

  it("refuses a name that is not one of the eighteen without sending it", async () => {
    const fake = fakePort(() => ok(null));
    const link = new HostLink({ connect: () => fake.port, now: () => 0 });
    await expect(link.ask("locker:reveal")).rejects.toThrow(
      /different versions/u
    );
    expect(fake.sent).toHaveLength(0);
  });
});

describe("the port's lifetime", () => {
  it("opens on first use and closes when idle", async () => {
    let clock = 0;
    const fake = fakePort(() => ok({ ok: true }));
    const link = new HostLink({ connect: () => fake.port, now: () => clock });
    expect(link.open).toBe(false);
    await link.ask("warm");
    expect(link.open).toBe(true);
    expect(link.idleFor()).toBe(false);
    clock += IDLE_CLOSE_MS;
    expect(link.idleFor()).toBe(true);
    link.close();
    expect(link.open).toBe(false);
    expect(fake.disconnected).toBe(1);
  });

  it("answers everything waiting when the port drops", async () => {
    const fake = fakePort(() => undefined);
    const link = new HostLink({ connect: () => fake.port, now: () => 0 });
    // A dropped port answers rather than hanging, which is the difference
    // between a refusal and a popup spinner that never stops.
    await expect(
      link.ask("locker:save", { pageUrl: "https://a.test" })
    ).rejects.toThrow(/not installed|port closed/u);
  });

  it("delivers an unsolicited frame as a push rather than as an answer", async () => {
    const pushed: unknown[] = [];
    let deliver: ((message: unknown) => void) | undefined;
    const port: NativePort = {
      postMessage: () => deliver?.(ok({ ok: true })),
      disconnect: () => undefined,
      onMessage: {
        addListener(fn) {
          deliver = fn;
        },
      },
      onDisconnect: { addListener: () => undefined },
    };
    const link = new HostLink({
      connect: () => port,
      now: () => 0,
      onPush: (frame) => pushed.push(frame),
    });
    await link.ask("warm");
    expect(pushed).toHaveLength(0);
    deliver?.({ t: "push", count: 4 });
    expect(pushed).toStrictEqual([{ t: "push", count: 4 }]);
  });
});

describe("the member sentences", () => {
  it("answers one sentence per code and never a raw error", () => {
    for (const code of KNOWN_CODES) {
      const sentence = memberSentence(code);
      expect(sentence.length).toBeGreaterThan(10);
      expect(sentence).not.toContain(code);
    }
  });

  it("falls back to the host's own detail rather than to nothing", () => {
    expect(
      memberSentence("stage-refused", "a chunk arrived out of order")
    ).toBe("a chunk arrived out of order");
    expect(memberSentence("stage-refused")).toMatch(/Open the app/u);
  });

  it("never puts a token in a sentence", () => {
    const spy = vi.fn<(code: string) => void>();
    for (const code of KNOWN_CODES) {
      if (/token/u.test(memberSentence(code))) spy(code);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
