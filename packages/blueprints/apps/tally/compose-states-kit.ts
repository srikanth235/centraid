import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect } from "vitest";

// THE FIXTURES AND THE MOUNT both `compose-states.test.tsx` files compose
// their routes out of.
//
// EVERY PATH A CALLER TAKES IS ONE A MEMBER CAN TAKE: `press` finds a control
// by the label the previous screen drew and clicks it, so a route reachable
// only from a test is a route nobody has. Nothing here sets app state from
// outside.
import { EMPTY_BAG, money, moneyBag, valuate } from "@centraid/core/money";

import type { InlineFrame } from "../inline-types.ts";
import { Root } from "./app-root.tsx";
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
  tz: "Europe/London",
  status: "active",
  preview: "the 1st of every month",
  next_start: "2099-09-01T09:00:00.000Z",
  paid_by: "me",
  category: "rent",
  splits_json: '[{"party_id":"me","weight":2},{"party_id":"ana","weight":1}]',
  rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
  anchor_start: "2024-03-01T09:00:00.000Z",
};

const UNPHRASED: RecurringTemplate = {
  ...TEMPLATE,
  template_id: "r4",
  description: "Window man",
  preview: null,
  next_start: null,
};

export const DASHBOARD: DashboardData = {
  me: "me",
  currency: "GBP",
  friends: [
    {
      party_id: "ana",
      name: "Ana",
      color: "",
      initials: "A",
      balances: [money(-4560, "GBP")],
    },
  ],
  groups: [
    {
      group_id: "flat",
      name: "14 Sitwell Road",
      member_count: 3,
      owner_net: money(6240, "GBP"),
    },
  ],
  archived_groups: [],
  trash: [],
  recurring: [TEMPLATE, UNPHRASED],
  owe: valuate(moneyBag(money(10_960, "GBP")), "GBP"),
  owed: valuate(moneyBag(money(8100, "GBP")), "GBP"),
  expense_count: 194,
  settlement_count: 22,
  rate_suggestions: [],
  nudges: [],
};

export const BARE: DashboardData = {
  ...DASHBOARD,
  friends: [],
  groups: [],
  recurring: [],
  owe: valuate(EMPTY_BAG, "GBP"),
  owed: valuate(EMPTY_BAG, "GBP"),
};

export const GROUP: GroupData = {
  me: "me",
  currency: "GBP",
  group: { group_id: "flat", name: "14 Sitwell Road" },
  members: [
    {
      party_id: "me",
      name: "You",
      color: "",
      initials: "Y",
      net: money(6240, "GBP"),
      is_me: true,
    },
    {
      party_id: "ana",
      name: "Ana",
      color: "",
      initials: "A",
      net: money(-4560, "GBP"),
    },
    {
      party_id: "tom",
      name: "Tom",
      color: "",
      initials: "T",
      net: money(8100, "GBP"),
    },
  ],
  ledger: [],
  simplification: {
    opted_in: false,
    transfers: [],
    debts_before: 5,
    payments_after: 5,
  },
};

export const GROUP_SIMPLIFIED: GroupData = {
  ...GROUP,
  group: { ...GROUP.group!, simplify_opt_in: true },
  simplification: {
    opted_in: true,
    transfers: [
      { from: "ana", to: "me", amount: money(4560, "GBP") },
      { from: "me", to: "tom", amount: money(8100, "GBP") },
    ],
    debts_before: 5,
    payments_after: 3,
  },
};

const ACTIVITY: ActivityData = { me: "me", currency: "GBP", activity: [] };

export const PARKED_BY_ANA = {
  intentId: "i-1",
  actorPartyId: "ana",
  command: "tally.add_receipt_expense",
  input: { description: "Beach hut deposit" },
  status: "parked",
  createdAt: "2026-08-20T10:00:00.000Z",
};

export interface ComposeHarness {
  mount: (
    dashboard: DashboardData,
    over?: { group?: GroupData; centraid?: Record<string, unknown> }
  ) => Promise<HTMLDivElement>;
  buttonNamed: (
    container: HTMLElement,
    label: string
  ) => HTMLButtonElement | undefined;
  press: (container: HTMLElement, label: string) => Promise<void>;
}

/** Call from a `describe` body: it registers its own teardown, so a suite that
 *  throws mid-route still leaves the document and the host bridge clean. */
export function composeHarness(): ComposeHarness {
  let reactRoot: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (reactRoot) act(() => reactRoot?.unmount());
    reactRoot = undefined;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  async function mount(
    dashboard: DashboardData,
    over: { group?: GroupData; centraid?: Record<string, unknown> } = {}
  ): Promise<HTMLDivElement> {
    // jsdom implements `<dialog>` without the modal half; the confirms open
    // with `showModal()` on purpose, so the kit supplies the two methods
    // rather than the app avoiding the door.
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
        if (query === "group") return Promise.resolve(over.group ?? GROUP);
        if (query === "history") return Promise.resolve({ revisions: [] });
        if (query === "export")
          return Promise.resolve({
            group: {
              group_id: "flat",
              name: "14 Sitwell Road",
              archived_at: null,
              members: [],
            },
            expenses: [],
            settlements: [],
            revisions: [],
            balances_excluded: true,
            truncated: false,
            window: { limit: 500, expenses: 194, settlements: 22 },
          });
        return Promise.resolve(ACTIVITY);
      },
      commonsIntents: () => Promise.resolve([]),
      ...over.centraid,
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

  return { mount, buttonNamed, press };
}
