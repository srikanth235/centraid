// @vitest-environment jsdom
// THE COMPOSING ROUTES, AND THE STATES THEY ANSWER (STATES.md's Tally matrix,
// umbrella #872).
//
// Wave 1 proved the ledger's states on Balances. These are the seven routes
// that WRITE, and what is asserted is the honest half of each: the commit that
// says where it lands, the chip that is drawn and refused, the schedule that
// has no sentence and therefore no preview, the one act that needs the gateway,
// and the surface whose whole subject is a file leaving the device.
//
// EVERY PATH HERE IS ONE A MEMBER CAN ACTUALLY TAKE. The routes are reached by
// pressing what the previous screen offers — day one's first move, the rail's
// own rows, a group ledger's section verbs — rather than by setting state from
// outside, because a route reachable only from a test is a route nobody has.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import type { InlineFrame } from "../inline-types.ts";
import { Root } from "./app-root.tsx";
import {
  ADD_HEAD,
  CONTRIB_EMPTY,
  CURRENCY_NOTE,
  DUE_OCCURRENCE,
  EXPORT_FOOT,
  NO_GROUP_LABEL,
  RECURRING_EMPTY,
  SETTLE_FOOT_THEIRS,
  SIMPLIFICATION,
  UNSUMMARISABLE,
  addFoot,
} from "./compose-copy.ts";
import type {
  ActivityData,
  DashboardData,
  GroupData,
  RecurringTemplate,
} from "./types.ts";

const NO_FRAME: InlineFrame = {
  setAppBar: () => undefined,
  setStatus: () => undefined,
  clearStatus: () => undefined,
  claimBand: () => undefined,
};

const TEMPLATE: RecurringTemplate = {
  template_id: "r1",
  group_id: "flat",
  description: "Rent",
  original_amount_minor: 145_000,
  original_currency: "GBP",
  settlement_currency: "GBP",
  time_zone: "Europe/London",
  status: "active",
  preview: "the 1st of every month",
  next_start: "2099-09-01T09:00:00.000Z",
  paid_by: "me",
  category: "rent",
  splits_json: '[{"party_id":"me","weight":2},{"party_id":"ana","weight":1}]',
  rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
  anchor_start: "2024-03-01T09:00:00.000Z",
};

/** The one whose rule the summariser could not phrase. */
const UNPHRASED: RecurringTemplate = {
  ...TEMPLATE,
  template_id: "r4",
  description: "Window man",
  preview: null,
  next_start: null,
};

const DASHBOARD: DashboardData = {
  me: "me",
  currency: "GBP",
  friends: [
    {
      party_id: "ana",
      name: "Ana",
      color: "",
      initials: "A",
      net_minor: -4560,
    },
  ],
  groups: [
    {
      group_id: "flat",
      name: "14 Sitwell Road",
      member_count: 3,
      owner_net_minor: 6240,
    },
  ],
  trash: [],
  recurring: [TEMPLATE, UNPHRASED],
  owe_total_minor: 10_960,
  owed_total_minor: 8100,
};

const BARE: DashboardData = {
  ...DASHBOARD,
  friends: [],
  groups: [],
  recurring: [],
  owe_total_minor: 0,
  owed_total_minor: 0,
};

const GROUP: GroupData = {
  me: "me",
  currency: "GBP",
  group: { group_id: "flat", name: "14 Sitwell Road" },
  members: [
    {
      party_id: "me",
      name: "You",
      color: "",
      initials: "Y",
      net_minor: 6240,
      is_me: true,
    },
    {
      party_id: "ana",
      name: "Ana",
      color: "",
      initials: "A",
      net_minor: -4560,
    },
    { party_id: "tom", name: "Tom", color: "", initials: "T", net_minor: 8100 },
  ],
  ledger: [],
};

const ACTIVITY: ActivityData = { me: "me", currency: "GBP", activity: [] };

let reactRoot: ReturnType<typeof createRoot> | undefined;

describe("Tally’s composing routes", () => {
  afterEach(() => {
    if (reactRoot) act(() => reactRoot?.unmount());
    reactRoot = undefined;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  async function mount(dashboard: DashboardData): Promise<HTMLDivElement> {
    // jsdom implements `<dialog>` without the modal half. The confirms open
    // with `showModal()` on purpose — it is what makes the backdrop, the focus
    // trap and Escape the platform's job — so the test supplies the two
    // methods rather than the app avoiding the door.
    const proto = window.HTMLDialogElement.prototype as unknown as {
      showModal?: () => void;
      close?: () => void;
    };
    proto.showModal ??= function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    proto.close ??= function close(this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    // A POINTER SURFACE, explicitly. `observeWidth` measures `clientWidth`,
    // which jsdom reports as 0 — every app would render at its narrow rung and
    // the rail, the second section verb and the desktop switcher would all be
    // withheld. The pane is given a width so the wide layout is the one under
    // test; the narrow rung is Wave 1's own concern and has its own cases.
    Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
      configurable: true,
      value: 1200,
    });
    (window as unknown as { centraid: unknown }).centraid = {
      read: ({ query }: { query: string }) => {
        if (query === "dashboard") return Promise.resolve(dashboard);
        if (query === "group") return Promise.resolve(GROUP);
        if (query === "history") return Promise.resolve({ revisions: [] });
        return Promise.resolve(ACTIVITY);
      },
      commonsIntents: () => Promise.resolve([]),
    };
    const container = document.createElement("div");
    document.body.append(container);
    reactRoot = createRoot(container);
    await act(async () => {
      reactRoot?.render(
        createElement(Root, { rootRef: () => undefined, frame: NO_FRAME })
      );
    });
    return container;
  }

  function buttonNamed(
    container: HTMLElement,
    label: string
  ): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label
    );
  }

  /** A row or a rail entry: its own name, then whatever the row carries beside
   *  it — a count, a meta sentence, a figure. */
  function rowNamed(
    container: HTMLElement,
    label: string
  ): HTMLButtonElement | undefined {
    return (
      buttonNamed(container, label) ??
      [...container.querySelectorAll("button")].find((button) =>
        (button.textContent ?? "").startsWith(label)
      )
    );
  }

  /** Press something and let the whole read chain land inside the act scope. */
  async function press(container: HTMLElement, label: string): Promise<void> {
    const button = rowNamed(container, label);
    expect(button, `no control named “${label}”`).toBeDefined();
    await act(async () => {
      button?.click();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }

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
      // The chip exists — the design draws it — and the note beside it carries
      // the ruling that has to come first, tagged where a reviewer reads it.
      expect(buttonNamed(container, NO_GROUP_LABEL)).toBeDefined();
      expect(container.textContent).toContain("[open-question]");
      expect(container.textContent).toContain("the command requires a group");
      // And nothing commits out of an empty draft.
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
    });

    test("all six divisions are drawn, and three carry the gap tag", async () => {
      const container = await mount(BARE);
      await press(container, "Add an expense");
      expect(buttonNamed(container, "Equally")).toBeDefined();
      expect(buttonNamed(container, "Exact amounts")).toBeDefined();
      expect(buttonNamed(container, "Percentages")).toBeDefined();
      expect(buttonNamed(container, "Shares · [backend-needed]")).toBeDefined();
      expect(
        buttonNamed(container, "Equally, adjusted · [backend-needed]")
      ).toBeDefined();
      expect(
        buttonNamed(container, "By line · [backend-needed]")
      ).toBeDefined();
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

    test("draws the simplification proposal against the ask, verbatim", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "Settle up");
      expect(container.textContent).toContain(SIMPLIFICATION);
      expect(buttonNamed(container, "Turn it on")?.disabled).toBe(true);
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

  // ------------------------------------------------------------------ Export

  describe("Export", () => {
    test("states the foot verbatim and refuses the commit", async () => {
      const container = await mount(DASHBOARD);
      await press(container, "14 Sitwell Road");
      await press(container, "Export");
      expect(container.textContent).toContain(EXPORT_FOOT);
      expect(buttonNamed(container, "Export")?.disabled).toBe(true);
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
