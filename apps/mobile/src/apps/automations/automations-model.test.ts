import { describe, expect, it } from "vitest";

import type { AutomationRow } from "../../lib/automations";
import {
  automationRowCopy,
  automationsHealth,
  countSentence,
  errorBody,
  failureStreak,
  filterChips,
  automationMatchesFilter,
  opsStateFor,
  runRowCopy,
  showingSentence,
  statusOf,
  suggestionRowCopy,
  whenLabel,
  worstFailure,
} from "./automations-model";
import type { RunContext, RunEntry } from "./automations-model";

const NOW = Date.parse("2026-08-13T09:20:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function row(over: Partial<AutomationRow> = {}): AutomationRow {
  return {
    description: "",
    enabled: true,
    id: "digest",
    name: "Weekly digest",
    ref: "mail/digest",
    scheduleLabel: "Monday 8:00",
    ...over,
  };
}

function run(over: Partial<RunEntry> = {}): RunEntry {
  return {
    detail: "3 files",
    key: "t1",
    name: "Weekly digest",
    ok: true,
    ref: "mail/digest",
    startedAt: NOW - HOUR,
    ...over,
  };
}

function context(
  runs: readonly RunEntry[],
  refs = ["mail/digest"]
): RunContext {
  return { known: new Set(refs), now: NOW, runs };
}

describe(failureStreak, () => {
  it("counts back from the newest run and stops at the first success", () => {
    const runs = [
      run({ key: "t3", ok: false, startedAt: NOW - HOUR }),
      run({ key: "t2", ok: false, startedAt: NOW - 2 * DAY }),
      run({ key: "t1", ok: true, startedAt: NOW - 3 * DAY }),
      run({ key: "t0", ok: false, startedAt: NOW - 4 * DAY }),
    ];
    expect(failureStreak("mail/digest", runs)).toStrictEqual({
      count: 2,
      startedAt: NOW - 2 * DAY,
    });
  });

  it("is null when the newest run succeeded, and when there are no runs", () => {
    expect(failureStreak("mail/digest", [run()])).toBeNull();
    expect(failureStreak("mail/digest", [])).toBeNull();
  });

  it("ignores other automations' runs", () => {
    expect(
      failureStreak("mail/digest", [run({ ok: false, ref: "files/tidy" })])
    ).toBeNull();
  });
});

describe(statusOf, () => {
  it("calls a disabled automation Paused, whatever its runs did", () => {
    expect(
      statusOf(row({ enabled: false }), context([run({ ok: false })]))
    ).toBe("paused");
  });

  it("calls an automation with a leading failure Failing", () => {
    expect(statusOf(row(), context([run({ ok: false })]))).toBe("failing");
  });

  it("calls an automation whose runs were read, and has none, a Draft", () => {
    expect(statusOf(row(), context([]))).toBe("draft");
  });

  it("never calls an automation a Draft when its runs were not read", () => {
    expect(statusOf(row(), { known: new Set(), now: NOW, runs: [] })).toBe(
      "active"
    );
  });
});

describe(automationRowCopy, () => {
  it("names the failure streak in the sub, and tones only the metadata", () => {
    const copy = automationRowCopy(
      row(),
      context([
        run({ key: "t2", ok: false, startedAt: NOW - HOUR }),
        run({
          key: "t1",
          ok: false,
          startedAt: Date.parse("2026-08-04T08:00:00.000Z"),
        }),
      ])
    );
    expect(copy.title).toBe("Weekly digest");
    expect(copy.sub).toContain("Monday 8:00 · failed 2 runs in a row, since ");
    expect(copy.meta).toBe("Failing");
    expect(copy.net).toBe(true);
    expect(copy.action).toBe("Open");
    expect(copy.act).toBe("open");
  });

  it("gives a paused row the Resume verb, and nothing else", () => {
    const copy = automationRowCopy(row({ enabled: false }), context([run()]));
    expect(copy.meta).toBe("Paused");
    expect(copy.action).toBe("Resume");
    expect(copy.act).toBe("resume");
    expect(copy.net).toBe(false);
  });

  it("says never run only when the run window is an answer for it", () => {
    expect(automationRowCopy(row(), context([])).sub).toBe(
      "Monday 8:00 · never run"
    );
    expect(
      automationRowCopy(row(), { known: new Set(), now: NOW, runs: [] }).sub
    ).toBe("Monday 8:00");
  });
});

describe(whenLabel, () => {
  it("reads as a clock today, a word yesterday, and a date past the week", () => {
    expect(whenLabel(NOW - HOUR, NOW)).toMatch(/\d/u);
    expect(whenLabel(NOW - 30 * HOUR, NOW)).toBe("yesterday");
    expect(whenLabel(NOW - 30 * DAY, NOW)).toContain("July");
  });
});

describe(runRowCopy, () => {
  it("states the outcome, the run's own sentence, and when", () => {
    const copy = runRowCopy(run({ startedAt: NOW - 30 * HOUR }), NOW);
    expect(copy.sub).toBe("Succeeded · 3 files · yesterday");
    expect(copy.meta).toBe("Yesterday");
    expect(copy.net).toBe(false);
  });

  it("puts a failed run's state word in the meta slot, in net", () => {
    const copy = runRowCopy(
      run({ detail: "Gmail token expired", ok: false }),
      NOW
    );
    expect(copy.sub).toContain("Failed · Gmail token expired · ");
    expect(copy.meta).toBe("Failed");
    expect(copy.net).toBe(true);
  });
});

describe("the section heading and the chips", () => {
  it("counts the list the way the reference's meta line does", () => {
    const copies = [
      automationRowCopy(row(), context([run({ ok: false })])),
      automationRowCopy(
        row({ enabled: false, ref: "files/tidy" }),
        context([], ["files/tidy"])
      ),
      automationRowCopy(row({ ref: "quotes/follow" }), context([], [])),
    ];
    expect(countSentence(copies)).toBe("3 automations · 1 failing · 1 paused");
    expect(showingSentence(1, 3)).toBe("showing 1 of 3");
  });

  it("offers the reference's four narrowings, with the live one marked", () => {
    expect(filterChips("failing").map((chip) => chip.label)).toStrictEqual([
      "All",
      "Failing",
      "Paused",
      "Drafts",
    ]);
    expect(filterChips("failing").filter((chip) => chip.on)).toHaveLength(1);
    expect(automationMatchesFilter("draft", "drafts")).toBe(true);
    expect(automationMatchesFilter("active", "failing")).toBe(false);
    expect(automationMatchesFilter("active", "all")).toBe(true);
  });
});

describe(opsStateFor, () => {
  it("derives empty and full from the row count, never from a mode", () => {
    expect(opsStateFor("loading", 0)).toBe("loading");
    expect(opsStateFor("error", 4)).toBe("error");
    expect(opsStateFor("ready", 0)).toBe("empty");
    expect(opsStateFor("ready", 6)).toBe("ready");
    expect(opsStateFor("ready", 8)).toBe("full");
  });
});

describe("the standing line", () => {
  it("names the longest streak, and offers the one verb that reaches it", () => {
    const once = automationRowCopy(
      row({ name: "Tidy downloads", ref: "files/tidy" }),
      {
        known: new Set(["files/tidy"]),
        now: NOW,
        runs: [run({ ok: false, ref: "files/tidy" })],
      }
    );
    const thrice = automationRowCopy(
      row(),
      context([
        run({ key: "a", ok: false }),
        run({ key: "b", ok: false, startedAt: NOW - 2 * DAY }),
        run({ key: "c", ok: false, startedAt: NOW - 3 * DAY }),
      ])
    );
    const copies = [once, thrice];
    expect(worstFailure(copies)?.title).toBe("Weekly digest");
    const health = automationsHealth(copies, [], NOW);
    expect(health.label).toBe("2 automations are failing");
    expect(health.detail).toContain(
      "Weekly digest has failed its last 3 runs, since "
    );
    expect(health.action).toBe("Open the failure");
  });

  it("falls back to a healthy sentence with no verb at all", () => {
    const copies = [automationRowCopy(row(), context([run()]))];
    const health = automationsHealth(copies, [run()], NOW);
    expect(health.label).toBe("Nothing is failing");
    expect(health.detail).toContain("1 automation on this gateway · last run ");
    expect(health.action).toBeUndefined();
  });

  it("says nothing has run yet rather than inventing a last run", () => {
    const copies = [automationRowCopy(row(), context([]))];
    expect(automationsHealth(copies, [], NOW).detail).toBe(
      "1 automation on this gateway · nothing has run yet."
    );
  });
});

describe(errorBody, () => {
  it("drops the since clause when no reading ever gave it a clock", () => {
    expect(errorBody(undefined)).toBe(
      "Runs queue until the scheduler is back."
    );
    expect(errorBody("09:12")).toBe(
      "Nothing has run since 09:12; runs queue until the scheduler is back."
    );
  });
});

describe(suggestionRowCopy, () => {
  it("offers Create, and says so while the write is in flight", () => {
    const template = {
      desc: "Pull mail into the vault",
      id: "google-gmail-pull",
      name: "Gmail",
      triggerLabel: "Every 15 minutes",
    };
    expect(suggestionRowCopy(template, undefined)).toStrictEqual({
      action: "Create",
      key: "google-gmail-pull",
      sub: "Pull mail into the vault · Every 15 minutes",
      title: "Gmail",
    });
    expect(suggestionRowCopy(template, "google-gmail-pull").action).toBe(
      "Adding…"
    );
  });
});
