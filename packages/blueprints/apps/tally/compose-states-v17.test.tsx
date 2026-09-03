// @vitest-environment jsdom
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
      expect(buttonNamed(container, "Add a line")).toBeDefined();
      expect(container.textContent).toContain(
        "Type the lines, then press whoever was on each of them."
      );
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
      expect(buttonNamed(container, "Export")?.disabled).toBe(true);
      expect(container.textContent).toContain(
        "A group · a ledger is a group's"
      );
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
