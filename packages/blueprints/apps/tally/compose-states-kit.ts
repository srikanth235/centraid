import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect } from "vitest";

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
  archived_groups: [],
  trash: [],
  recurring: [TEMPLATE, UNPHRASED],
  owe_total_minor: 10_960,
  owed_total_minor: 8100,
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
  owe_total_minor: 0,
  owed_total_minor: 0,
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
      { from: "ana", to: "me", amount_minor: 4560 },
      { from: "me", to: "tom", amount_minor: 8100 },
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
