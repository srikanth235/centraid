// @vitest-environment jsdom
// THE COMPOSING ROUTES, AND THE STATES THEY ANSWER (STATES.md's Tally matrix,
// umbrella #872).
//
// Wave 1 proved the ledger's states on Balances. These are the routes that
// WRITE, and what is asserted is the honest half of each: the commit that says
// where it lands, the chip that is drawn and refused, the schedule that has no
// sentence and therefore no preview, and the sheets that mint something. The
// later routes — the tables, the simplification proposal, the doors that leave
// a group or leave the device — are in `compose-states-v17.test.tsx`; the
// fixtures and the mount both files use are `compose-states-kit.ts`.
//
// EVERY PATH HERE IS ONE A MEMBER CAN ACTUALLY TAKE. The routes are reached by
// pressing what the previous screen offers — day one's first move, the rail's
// own rows, a group ledger's section verbs — rather than by setting state from
// outside, because a route reachable only from a test is a route nobody has.
import { describe, expect, test } from "vitest";

import {
  ADD_HEAD,
  CONTRIB_EMPTY,
  CURRENCY_NOTE,
  CURRENCY_NOTE_2,
  DUE_OCCURRENCE,
  NO_GROUP_LABEL,
  RECURRING_EMPTY,
  SETTLE_FOOT_THEIRS,
  UNSUMMARISABLE,
  addFoot,
} from "./compose-copy.ts";
import { BARE, DASHBOARD, composeHarness } from "./compose-states-kit.ts";

describe("Tally’s composing routes", () => {
  const { mount, buttonNamed, press } = composeHarness();

  // ------------------------------------------------------------ Add expense

  describe("Add expense", () => {
    test("day one's first move opens it, and it says where the write lands", async () => {
      const container = await mount(BARE);
      await press(container, "Add an expense");
      expect(container.textContent).toContain(ADD_HEAD);
      // The foot names the destination BEFORE the commit rather than after.
      expect(container.textContent).toContain(addFoot(null));
    });

    test("*No group* is drawn, and the open question is on the field", async () => {
      const container = await mount(BARE);
      await press(container, "Add an expense");
      // The chip is a WRITE now: a group-less expense checks its participants
      // against the friend roster instead of a circle.
      expect(buttonNamed(container, NO_GROUP_LABEL)).toBeDefined();
      expect(container.textContent).not.toContain("[open-question]");
      expect(container.textContent).not.toContain(
        "the command requires a group"
      );
      expect(container.textContent).toContain("friend roster");
      // And nothing commits out of an empty draft — for want of a description,
      // which is what the refusal now says.
      expect(buttonNamed(container, "Add expense")?.disabled).toBe(true);
    });

    test("a disabled commit never takes the fill", async () => {
      const container = await mount(BARE);
      await press(container, "Add an expense");
      const commit = buttonNamed(container, "Add expense");
      expect(commit?.className).not.toContain("primary");
    });

    test("the currency note is on the field it governs, verbatim", async () => {
      const container = await mount(BARE);
      await press(container, "Add an expense");
      await press(container, "Another currency");
      expect(container.textContent).toContain(CURRENCY_NOTE);
      expect(container.textContent).toContain(CURRENCY_NOTE_2);
    });

    test("all six divisions are drawn, and none carries a gap tag", async () => {
      const container = await mount(BARE);
      await press(container, "Add an expense");
      for (const label of [
        "Equally",
        "Exact amounts",
        "Percentages",
        "Shares",
        "Equally, adjusted",
        "By line",
      ])
        expect(buttonNamed(container, label)).toBeDefined();
      expect(container.textContent).not.toContain("[backend-needed]");
    });

    test("opened from a group, it lands there and draws the allocation", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "14 Sitwell Road");
      await press(container, "Add expense");
      expect(container.textContent).toContain(addFoot("14 Sitwell Road"));
      // Every member of the group is a row in the table.
      expect(container.textContent).toContain("Tom");
      expect(container.textContent).toContain(
        "the odd penny goes to the payer, always"
      );
    });
  });

  // --------------------------------------------------------------- Settle up

  describe("Settle up", () => {
    test("says out loud when neither party is you", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "Settle up");
      // From defaults to the owner, so the foot reads the finance bridge…
      expect(container.textContent).toContain("finance ledger");
      // …and moves to the §6 line the moment the owner steps out of it.
      await press(container, "Ana");
      expect(container.textContent).toContain(SETTLE_FOOT_THEIRS);
    });

    test("*No group* is a real choice here, not a stated gap", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "Settle up");
      expect(buttonNamed(container, NO_GROUP_LABEL)).toBeDefined();
      // Settlements genuinely work group-less, so nothing here says otherwise.
      expect(container.textContent).not.toContain("the vault requires one");
    });
  });

  // --------------------------------------------------------------- Recurring

  describe("Recurring", () => {
    test("a rule that cannot be a sentence gets the §6 line and no preview", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "Recurring");
      expect(container.textContent).toContain("the 1st of every month");
      expect(container.textContent).toContain(UNSUMMARISABLE);
      expect(container.textContent).toContain("no preview");
      // And never the rule itself.
      expect(container.textContent).not.toContain("FREQ=MONTHLY");
    });

    test("Due next names the one write with no optimistic copy", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "Recurring");
      expect(container.textContent).toContain(DUE_OCCURRENCE);
      expect(buttonNamed(container, "Materialise")).toBeDefined();
    });

    test("a template that can be saved offers Pause; the section is never empty-by-guess", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "Recurring");
      expect(buttonNamed(container, "Pause")).toBeDefined();
      expect(container.textContent).not.toContain(RECURRING_EMPTY.templates);
    });
  });

  // ----------------------------------------------------------------- Waiting

  describe("Waiting", () => {
    test("empty is the healthy state, said three ways", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "Waiting");
      expect(container.textContent).toContain(CONTRIB_EMPTY.waiting);
      expect(container.textContent).toContain(CONTRIB_EMPTY.inFlight);
      expect(container.textContent).toContain(CONTRIB_EMPTY.ended);
    });
  });

  // ------------------------------------------------- the composing sheets

  describe("the sheets that mint something", () => {
    test("Add a friend asks for a name and will not commit without one", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "Add a friend");
      const dialog = document.querySelector("dialog");
      expect(dialog?.textContent).toContain("A friend is a person in People");
      expect(buttonNamed(container, "Add")?.disabled).toBe(true);
    });

    test("New group asks for a name, an icon and a colour", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "New group");
      expect(buttonNamed(container, "Home")).toBeDefined();
      expect(buttonNamed(container, "Indigo")).toBeDefined();
      expect(buttonNamed(container, "Create")?.disabled).toBe(true);
    });

    test("a group with no expenses may be deleted; the confirm is outlined", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "14 Sitwell Road");
      await press(container, "Delete group");
      const commit = buttonNamed(container, "Delete");
      expect(commit?.className).toContain("destructive");
      expect(commit?.disabled).toBe(false);
    });
  });
});
