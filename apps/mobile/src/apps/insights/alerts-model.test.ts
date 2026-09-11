// What Activity's alerts tab says (#1015 R-NY-2) — one standing line per
// source, in plain words, under test without a renderer.

import { describe, expect, it } from "vitest";

import type { MobileNotice } from "../../lib/gateway";
import {
  alertLines,
  alertRetryRef,
  alertStateWord,
  alertWhen,
} from "./alerts-model";

const NOW = Date.parse("2026-08-13T09:00:00.000Z");

function notice(over: Partial<MobileNotice> = {}): MobileNotice {
  return {
    archivedAt: null,
    count: 1,
    detail: {
      automationRef: "mail/nightly-digest",
      outcome: "failure",
      sourceType: "automation",
    },
    firstAt: "2026-08-13T06:00:00.000Z",
    headline: "Nightly digest did not finish",
    kind: "automation",
    lastAt: "2026-08-13T08:00:00.000Z",
    noticeId: "n-1",
    readAt: null,
    severity: "high",
    sourceRef: "mail/nightly-digest",
    ...over,
  };
}

describe("an alert line", () => {
  it("says its state once, as a word, and news says none", () => {
    expect(alertStateWord(notice())).toBe("Failed");
    expect(
      alertStateWord(notice({ kind: "gateway-health", severity: "high" }))
    ).toBe("Down");
    expect(
      alertStateWord(notice({ kind: "gateway-health", severity: "warning" }))
    ).toBe("Degraded");
    expect(alertStateWord(notice({ severity: "info" }))).toBe("");
  });

  it("says when in the member's words, and never the engine's", () => {
    const sub = alertWhen(
      notice({ count: 6, firstAt: "2026-08-07T08:00:00.000Z" }),
      NOW
    );
    expect(sub).toBe("6 times · 1 hour ago");
    // The three phrasings the simulator audit read off this screen.
    for (const banned of ["automation", "last ", "×", "over ", "failing"]) {
      expect(sub).not.toContain(banned);
    }
  });

  it("counts only a problem, never the past failures behind a recovery", () => {
    expect(alertWhen(notice({ count: 4, severity: "info" }), NOW)).toBe(
      "1 hour ago"
    );
    expect(alertWhen(notice({ count: 1 }), NOW)).toBe("1 hour ago");
  });

  it("offers a re-run for a failed rule, and for nothing else", () => {
    expect(alertRetryRef(notice())).toBe("mail/nightly-digest");
    // No `automationRef` detail: the source IS the rule.
    expect(
      alertRetryRef(
        notice({
          detail: { outcome: "failure", sourceType: "automation" },
          sourceRef: "tasks/import",
        })
      )
    ).toBe("tasks/import");
    expect(
      alertRetryRef(
        notice({
          detail: { outcome: "success", sourceType: "automation" },
          severity: "info",
        })
      )
    ).toBeUndefined();
    expect(
      alertRetryRef(
        notice({ detail: {}, kind: "gateway-health", sourceRef: "gateway" })
      )
    ).toBeUndefined();
  });

  it("stands one line per source, and drops what was filed away", () => {
    const lines = alertLines(
      [
        notice(),
        notice({
          archivedAt: "2026-08-13T08:30:00.000Z",
          noticeId: "n-2",
          sourceRef: "old/rule",
        }),
        notice({
          detail: {},
          headline: "Your vault's home machine is back",
          kind: "gateway-health",
          noticeId: "n-3",
          severity: "info",
          sourceRef: "gateway",
        }),
      ],
      NOW
    );
    expect(lines.map(({ line }) => line.key)).toStrictEqual(["n-1", "n-3"]);
    const [failed, news] = lines.map(({ line }) => line);
    expect(failed).toMatchObject({
      meta: "Failed",
      net: true,
      retryRef: "mail/nightly-digest",
      title: "Nightly digest did not finish",
    });
    // "Failed" is said once: the meta says it, the sub does not.
    expect(failed?.sub.toLowerCase()).not.toContain("fail");
    expect(news).toMatchObject({ meta: "", net: false, retryRef: undefined });
  });
});
