// @vitest-environment jsdom
// THE COMPOSING ROUTES THAT ARRIVED WITH THE TABLES AND THE DOORS (STATES.md's
// Tally matrix, #872) — sibling of `compose-states.test.tsx`, same kit.
//
// EVERY PATH HERE IS ONE A MEMBER CAN ACTUALLY TAKE — reached by pressing what
// the previous screen offers, never by setting state from outside.
import { describe, expect, test } from "vitest";

import { EXPORT_FOOT, SIMPLIFICATION } from "./compose-copy.ts";
import {
  DASHBOARD,
  GROUP,
  GROUP_SIMPLIFIED,
  PARKED_BY_ANA,
  composeHarness,
} from "./compose-states-kit.ts";

describe("Tally’s composing routes — the tables and the doors", () => {
  const { mount, buttonNamed, press } = composeHarness();

  describe("Add expense", () => {
    test("*By line* swaps the table for typed lines with a chip per member", async () => {
      const container = await mount(DASHBOARD, { group: GROUP });
      await press(container, "14 Sitwell Road");
      await press(container, "Add expense");
      await press(container, "By line");
      // One empty line opens with it, because a table with no rows is a
      // control with nothing to press.
      expect(buttonNamed(container, "Add a line")).toBeDefined();
      expect(container.textContent).toContain(
        "Type the lines, then press whoever was on each of them."
      );
      // And the reconcile line states the arithmetic, not a verdict word.
      expect(container.textContent).toContain("the expense is");
    });

    test("the payer table takes an amount from anyone who put money down", async () => {
      const container = await mount(DASHBOARD, { group: GROUP });
      await press(container, "14 Sitwell Road");
      await press(container, "Add expense");
      expect(container.querySelector("#tally-paid-ana")).not.toBeNull();
      expect(container.textContent).toContain(
        "Several payers each put down their part, and the parts sum to the total."
      );
    });
  });

  describe("Settle up", () => {
    test("offers the opt-in, verbatim, once a group is in scope", async () => {
      const container = await mount(DASHBOARD, { group: GROUP });
      await press(container, "Settle up");
      await press(container, "14 Sitwell Road");
      expect(container.textContent).toContain(SIMPLIFICATION);
      // OFF BY DEFAULT, and the control offers to turn it on rather than
      // refusing: the write exists, and it stores one flag.
      expect(container.textContent).toContain(
        "Off for this group · debts read as they were incurred"
      );
      expect(buttonNamed(container, "Turn it on")?.disabled).toBe(false);
    });

    test("shows the minimal transfers, and what they changed, when opted in", async () => {
      const container = await mount(DASHBOARD, { group: GROUP_SIMPLIFIED });
      await press(container, "Settle up");
      await press(container, "14 Sitwell Road");
      expect(container.textContent).toContain("5 debts become 3 payments");
      expect(container.textContent).toContain("Ana pays You £45.60");
      expect(buttonNamed(container, "Turn it off")).toBeDefined();
    });
  });

  describe("Waiting", () => {
    test("the steward answers here where the decide door exists", async () => {
      const container = await mount(DASHBOARD, {
        centraid: {
          commonsIntents: () => Promise.resolve([PARKED_BY_ANA]),
          decideCommonsIntent: () =>
            Promise.resolve({ decided: true, status: "executed" }),
        },
      });
      await press(container, "Waiting");
      expect(buttonNamed(container, "Approve")).toBeDefined();
      expect(buttonNamed(container, "Decline")).toBeDefined();
    });

    test("a host without the decide door draws neither, and no substitute", async () => {
      // Protocol C1: an absent door is offered as nothing at all — never as a
      // control that cannot fire, and never as a fallback pretending to be it.
      const container = await mount(DASHBOARD, {
        centraid: {
          commonsIntents: () => Promise.resolve([PARKED_BY_ANA]),
        },
      });
      await press(container, "Waiting");
      expect(buttonNamed(container, "Approve")).toBeUndefined();
      expect(buttonNamed(container, "Decline")).toBeUndefined();
      expect(container.textContent).toContain(
        "This host holds no approval inbox, so the act waits where it is"
      );
    });

    test("a prepared reminder reads as prepared, and never as sent", async () => {
      const container = await mount({
        ...DASHBOARD,
        nudges: [
          {
            nudge_id: "n1",
            party_id: "ana",
            group_id: null,
            prepared_at: "2026-08-20T10:00:00.000Z",
            note: null,
            sent: false,
          },
        ],
      });
      await press(container, "Waiting");
      expect(container.textContent).toContain("Reminders prepared");
      expect(container.textContent).toContain("Ana · prepared 2026-08-20");
      expect(container.textContent).toContain("nothing is sent from here");
    });
  });

  describe("Export", () => {
    test("states the foot verbatim, and the window it would carry", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "14 Sitwell Road");
      await press(container, "Export");
      expect(container.textContent).toContain(EXPORT_FOOT);
      // A LEDGER IS A GROUP'S, so nothing is exportable until one is named —
      // and the refusal says which field is missing.
      expect(buttonNamed(container, "Export")?.disabled).toBe(true);
      expect(container.textContent).toContain(
        "A group · a ledger is a group's"
      );
      // Named, the read lands and the window is the query's own count.
      await press(container, "14 Sitwell Road");
      expect(container.textContent).toContain(
        "194 expenses and 22 settlements"
      );
      expect(buttonNamed(container, "Export")?.disabled).toBe(false);
    });
  });

  describe("the two acts that take a group out of the lists", () => {
    test("leave asks in the §6 words, and the commit is live", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "14 Sitwell Road");
      await press(container, "Leave");
      expect(container.textContent).toContain(
        "Your rows stay on the ledger, marked departed, and your balance with the group stays visible."
      );
      // §6's "Settle first if you can." minus the filler the repo's copy rule
      // bans; the advice it carries is unchanged.
      expect(container.textContent).toContain("Settle first.");
      expect(buttonNamed(container, "Leave")?.disabled).toBe(false);
    });

    test("archive asks in the §6 words, and the commit is live", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "14 Sitwell Road");
      await press(container, "Archive");
      expect(container.textContent).toContain(
        "It leaves the lists and keeps everything."
      );
      expect(container.textContent).toContain(
        "Archiving is not deleting, and it does not need a settled balance."
      );
      expect(buttonNamed(container, "Archive")?.disabled).toBe(false);
    });

    test("archived groups keep a section of their own, with the way back", async () => {
      const container = await mount({
        ...DASHBOARD,
        archived_groups: [
          {
            group_id: "coast",
            name: "Coast trip",
            member_count: 4,
            owner_net_minor: 0,
            archived_at: "2026-05-01T00:00:00.000Z",
          },
        ],
      });
      // Groups is reached the way a member reaches it: out of a group ledger.
      await press(container, "14 Sitwell Road");
      await press(container, "Groups");
      expect(container.textContent).toContain("Archived");
      expect(container.textContent).toContain("Coast trip");
      expect(buttonNamed(container, "Bring back")).toBeDefined();
    });

    test("an empty archive says so, rather than leaving the section out", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "14 Sitwell Road");
      await press(container, "Groups");
      expect(container.textContent).toContain("No groups are archived.");
    });
  });

  describe("a reminder is prepared, never sent", () => {
    test("the confirm says it parks, before the press", async () => {
      // A reminder is for a row that owes YOU: positive is owed to you.
      const container = await mount({
        ...DASHBOARD,
        friends: [
          {
            party_id: "tom",
            name: "Tom",
            color: "",
            initials: "T",
            net_minor: 8100,
          },
        ],
      });
      await press(container, "Remind");
      expect(container.textContent).toContain("Remind Tom?");
      expect(container.textContent).toContain(
        "Prepared, awaiting your confirmation · nothing is sent from here"
      );
      expect(buttonNamed(container, "Prepare it")?.disabled).toBe(false);
    });
  });
});
