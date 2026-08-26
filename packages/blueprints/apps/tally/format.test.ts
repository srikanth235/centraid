// The app's ONE sign convention, and the words that carry it (spec §2).
//
// Positive is owed to you, negative is owed by you — expressed once, in
// `figureTone`, so a figure never needs a legend. Everything below is a case
// where getting it wrong would still LOOK right on screen: a settled balance
// painted as a debt, a debt painted in ink, a minus sign doing the work a word
// is supposed to do, or a green anywhere at all.
import { describe, expect, it } from "vitest";

import {
  allSettled,
  figureTone,
  groupSubLabel,
  metaSentence,
  money,
  netFigure,
  personSubLabel,
  proportion,
  roleSubLabel,
  roleTone,
} from "./format.ts";

describe("the sign convention", () => {
  it.each([
    [8100, "owed"],
    [-4560, "net"],
    [0, "settled"],
  ])("paints %i as %s", (net, tone) => {
    expect(figureTone(net)).toBe(tone);
  });

  it("treats a balance that rounds to nothing as level", () => {
    // A row reading "you owe £0.00" in the danger tone is a warning about
    // nothing, which is worse than no row at all.
    expect(figureTone(0)).toBe("settled");
    expect(netFigure(0, "GBP")).toBe("settled");
  });

  it("never puts a minus sign in the figure — the words carry direction", () => {
    expect(money(-4560, "GBP")).not.toContain("-");
    expect(money(-4560, "GBP")).toBe(money(4560, "GBP"));
    expect(personSubLabel(-4560)).toBe("you owe");
    expect(personSubLabel(8100)).toBe("owes you");
    expect(personSubLabel(0)).toBe("");
  });

  it("phrases a group's position as the owner's, not the group's", () => {
    // A group does not owe; the members do.
    expect(groupSubLabel(-100)).toBe("you owe");
    expect(groupSubLabel(100)).toBe("owed to you");
  });

  it("asks the whole room whether it is level", () => {
    expect(allSettled([0, 0, 0])).toBe(true);
    expect(allSettled([0, -1_200])).toBe(false);
    expect(allSettled([])).toBe(true);
  });
});

describe("a ledger row's own figure", () => {
  it("keeps fronting an expense in ink and owing a share in --net", () => {
    expect(roleTone("lent")).toBe("owed");
    expect(roleSubLabel("lent")).toBe("your share");
    expect(roleTone("borrowed")).toBe("net");
    expect(roleSubLabel("borrowed")).toBe("you owe");
  });

  it("says so when the expense is nobody's business of the owner's", () => {
    expect(roleTone("none")).toBe("settled");
    expect(roleSubLabel("none")).toBe("not yours");
  });
});

describe("the meta sentence", () => {
  it("drops a part the caller does not know, separator and all", () => {
    expect(metaSentence(["today", undefined, "Ana paid", false, null])).toBe(
      "today  ·  Ana paid"
    );
  });

  it("is empty when nothing is known, rather than a run of separators", () => {
    expect(metaSentence([undefined, false, ""])).toBe("");
  });
});

describe("the proportion bar", () => {
  it("is a share of the largest row, whole-numbered", () => {
    expect(proportion(50, 100)).toBe(50);
    expect(proportion(100, 100)).toBe(100);
  });

  it("cannot exceed its own track, or go under it", () => {
    // A bar wider than its track is a rendering bug wearing a data costume.
    expect(proportion(200, 100)).toBe(100);
    expect(proportion(-5, 100)).toBe(0);
    expect(proportion(10, 0)).toBe(0);
  });
});
