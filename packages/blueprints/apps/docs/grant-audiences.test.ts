// What Docs does with a roster read (#825): three states, three behaviours.
// The bug this pins is the collapse — a read that FAILED answering `[]`, so a
// member with a full People directory was told they knew nobody.
import { describe, expect, test } from "vitest";

import { ROSTER_UNREADABLE } from "../_shared/grant-audiences.ts";
import { docsRosterAnswer } from "./grant-audiences.ts";

describe("the Docs host reading its roster", () => {
  test("a roster with people is what Share may name, and says nothing", () => {
    expect(
      docsRosterAnswer({
        ok: true,
        audiences: [{ kind: "party", id: "party-asha", label: "Asha" }],
      })
    ).toStrictEqual({
      audiences: [{ kind: "party", id: "party-asha", label: "Asha" }],
      status: null,
    });
  });

  test("an EMPTY roster is still an answer: Share is drawn, over nobody", () => {
    // The sheet says "nobody yet" in its own words once opened; the host does
    // not withhold the verb, because the vault genuinely answered.
    expect(docsRosterAnswer({ ok: true, audiences: [] })).toStrictEqual({
      audiences: [],
      status: null,
    });
  });

  test("an UNREADABLE roster draws no Share verb, and says why", () => {
    expect(docsRosterAnswer({ ok: false })).toStrictEqual({
      audiences: null,
      status: ROSTER_UNREADABLE,
    });
  });

  test("the failure is never spoken as the empty roster's sentence", () => {
    const failed = docsRosterAnswer({ ok: false });
    const empty = docsRosterAnswer({ ok: true, audiences: [] });
    expect(failed.status).not.toBe(empty.status);
    expect(failed.audiences).toBeNull();
    expect(empty.audiences).toStrictEqual([]);
  });
});
