// The phone's memory of "why is my library downloading again" (#883 C6).
// The sentences themselves belong to `@centraid/client/replica`; what is
// pinned here is WHICH frames earn a notice and which say nothing.

import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  clearResyncNotice,
  noteResyncVerdict,
  readResyncNotice,
  subscribeResyncNotice,
} from "./resync-notice";

const RETENTION_FRAME = {
  error: "replica_rebootstrap_required",
  reason: "retention",
  retention: { days: 30, maxEntries: 100_000 },
};

describe("the phone's re-sync notice", () => {
  beforeEach(() => {
    clearResyncNotice();
  });

  describe("what earns a notice", () => {
    test("the 30-day-offline phone is told, with the gateway's own window", () => {
      expect(noteResyncVerdict(RETENTION_FRAME, "vault-1")).toBe(true);
      const notice = readResyncNotice();
      expect(notice?.verdict).toBe("retention");
      expect(notice?.detail).toContain("30 days");
      expect(notice?.scopeId).toBe("vault-1");
    });

    // The promise moved from the detail to the HEADLINE (#883 W-F1): it is
    // true of every full re-sync, so it is stated once where every one of them
    // shows it rather than four times in seven details.
    test("a full re-sync never reads as lost work", () => {
      noteResyncVerdict(RETENTION_FRAME);
      expect(readResyncNotice()?.headline).toContain(
        "unsent changes stay queued"
      );
    });

    test("a first sync is machinery, not a notice", () => {
      expect(noteResyncVerdict({ reason: "initial" })).toBe(false);
      expect(readResyncNotice()).toBeUndefined();
    });

    test("a shape-catalog refresh is machinery too — crying wolf costs the real one", () => {
      expect(noteResyncVerdict({ reason: "shape-changed" })).toBe(false);
      expect(readResyncNotice()).toBeUndefined();
    });

    test("a frame with no verdict this client knows records nothing", () => {
      expect(noteResyncVerdict({ reason: "who-knows" })).toBe(false);
      expect(noteResyncVerdict(undefined)).toBe(false);
      expect(readResyncNotice()).toBeUndefined();
    });
  });

  describe("delivery", () => {
    test("subscribers are told, and dismissal is the member's", () => {
      const seen: Array<string | undefined> = [];
      const stop = subscribeResyncNotice((notice) =>
        seen.push(notice?.verdict)
      );
      noteResyncVerdict(RETENTION_FRAME);
      expect(seen).toStrictEqual(["retention"]);
      clearResyncNotice();
      expect(seen).toStrictEqual(["retention", undefined]);
      expect(readResyncNotice()).toBeUndefined();
      stop();
    });

    test("one broken subscriber does not stop the others being told", () => {
      const seen: string[] = [];
      const stopBad = subscribeResyncNotice(() => {
        throw new Error("render blew up");
      });
      const stopGood = subscribeResyncNotice((notice) => {
        if (notice) seen.push(notice.verdict);
      });
      expect(() => noteResyncVerdict(RETENTION_FRAME)).not.toThrow();
      expect(seen).toStrictEqual(["retention"]);
      stopBad();
      stopGood();
    });

    test("an unsubscribed listener stops hearing", () => {
      const listener = vi.fn<(notice: unknown) => void>();
      subscribeResyncNotice(listener)();
      noteResyncVerdict(RETENTION_FRAME);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
