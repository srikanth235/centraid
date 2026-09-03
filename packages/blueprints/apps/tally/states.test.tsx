import { readFileSync } from "node:fs";
import path from "node:path";

import { act, createElement, useMemo, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import type { InlineFrame } from "../inline-types.ts";
import { Root } from "./app-root.tsx";
import type { DashboardData } from "./types.ts";
import {
  ALL_SETTLED,
  BALANCES_STATUS,
  DAY_ONE,
  DAY_ONE_SUB,
  DENIED_BODY,
  DENIED_REGRANT,
  DENIED_SCOPE,
  DENIED_TITLE,
  OFFLINE_NOTICE,
  PARKED_NOTICE,
  VERBS,
  pendingNotice,
  staleNotice,
} from "./view-copy.ts";

const SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "app-root.tsx"),
  "utf8"
);

const NO_FRAME: InlineFrame = {
  setAppBar: () => undefined,
  setStatus: () => undefined,
  clearStatus: () => undefined,
  claimBand: () => undefined,
};

interface Intent {
  status: string;
}

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
    { party_id: "tom", name: "Tom", color: "", initials: "T", net_minor: 8100 },
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
  recurring: [],
  owe_total_minor: 10_960,
  owed_total_minor: 8100,
  expense_count: 194,
  settlement_count: 22,
  rate_suggestions: [],
  nudges: [],
};

const LEVEL: DashboardData = {
  ...DASHBOARD,
  friends: DASHBOARD.friends.map((friend) => ({ ...friend, net_minor: 0 })),
  groups: DASHBOARD.groups.map((group) => ({ ...group, owner_net_minor: 0 })),
  owe_total_minor: 0,
  owed_total_minor: 0,
};

const BARE: DashboardData = {
  ...DASHBOARD,
  friends: [],
  groups: [],
  owe_total_minor: 0,
  owed_total_minor: 0,
};

let reactRoot: ReturnType<typeof createRoot> | undefined;
let hostEl: HTMLElement | null = null;

describe("Tally’s honest states", () => {
  afterEach(() => {
    if (reactRoot) act(() => reactRoot?.unmount());
    reactRoot = undefined;
    hostEl = null;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  async function mount(
    dashboard: DashboardData,
    intents: Intent[] = []
  ): Promise<HTMLDivElement> {
    (window as unknown as { centraid: unknown }).centraid = {
      read: ({ query }: { query: string }) =>
        query === "dashboard"
          ? Promise.resolve(dashboard)
          : Promise.resolve({ me: "me", currency: "GBP", activity: [] }),
      commonsIntents: () => Promise.resolve(intents),
    };
    const container = document.createElement("div");
    document.body.append(container);
    reactRoot = createRoot(container);
    await act(async () => {
      reactRoot?.render(
        createElement(Root, {
          rootRef: (el: HTMLElement | null) => {
            hostEl = el;
          },
          frame: NO_FRAME,
        })
      );
    });
    return container;
  }

  function sentences(container: HTMLElement): string[] {
    return [...container.querySelectorAll("span")].map(
      (span) => span.textContent ?? ""
    );
  }

  function buttonNamed(
    container: HTMLElement,
    label: string
  ): Element | undefined {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label
    );
  }

  test("contributing the bar does not re-enter the room", async () => {
    (window as unknown as { centraid: unknown }).centraid = {
      read: ({ query }: { query: string }) =>
        query === "dashboard"
          ? Promise.resolve(BARE)
          : Promise.resolve({ me: "me", currency: "GBP", activity: [] }),
      commonsIntents: () => Promise.resolve([]),
    };
    const container = document.createElement("div");
    document.body.append(container);
    reactRoot = createRoot(container);
    function Host() {
      const [, bump] = useReducer((n: number) => n + 1, 0);
      const frame = useMemo<InlineFrame>(
        () => ({
          setAppBar: () => bump(),
          setStatus: () => undefined,
          clearStatus: () => undefined,
          claimBand: () => undefined,
        }),
        []
      );
      return createElement(Root, {
        rootRef: () => undefined,
        frame,
      });
    }
    await act(async () => {
      reactRoot?.render(createElement(Host));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    expect(container.textContent).toContain(DAY_ONE);
  });

  async function settle(fire: () => void): Promise<void> {
    await act(async () => {
      fire();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }

  describe("one sign convention, and no legend", () => {
    test("a net you owe takes --net and one you are owed stays ink", async () => {
      const container = await mount(DASHBOARD);
      const figures = [
        ...container.querySelectorAll<HTMLElement>("[data-tone]"),
      ].map((node) => [node.textContent ?? "", node.dataset.tone] as const);
      const ana = figures.find(([text]) => text.includes("45.60"));
      const tom = figures.find(([text]) => text.includes("81.00"));
      expect(ana?.[1]).toBe("net");
      expect(tom?.[1]).toBe("owed");
    });

    test("the figure never carries a minus sign; the words carry the direction", async () => {
      const container = await mount(DASHBOARD);
      const owed = [...container.querySelectorAll("[data-tone='net']")].map(
        (node) => node.textContent ?? ""
      );
      expect(owed.length).toBeGreaterThan(0);
      for (const text of owed) expect(text).not.toContain("-");
      expect(sentences(container)).toContain("you owe");
    });

    test("the hero says where its figure came from, and what it is not", async () => {
      const container = await mount(DASHBOARD);
      const sub = container.textContent ?? "";
      expect(sub).toContain("Owed to you");
      expect(sub).toContain("Derived from 194 expenses and 22 settlements");
      expect(sub).toContain("no balance is stored, and none is ever sent.");
    });
  });

  describe("every balance level", () => {
    test("states it, and does not celebrate it", async () => {
      const container = await mount(LEVEL);
      expect(container.textContent).toContain(ALL_SETTLED);
      expect(container.querySelector(".kit-empty")).toBeNull();
    });

    test("a room with balances outstanding says nothing of the kind", async () => {
      const container = await mount(DASHBOARD);
      expect(container.textContent).not.toContain(ALL_SETTLED);
    });
  });

  describe("day one and denied look nothing alike", () => {
    test("day one offers the first real move", async () => {
      const container = await mount(BARE);
      expect(container.textContent).toContain(DAY_ONE);
      expect(container.textContent).toContain(DAY_ONE_SUB);
      expect(buttonNamed(container, "Add an expense")).toBeDefined();
      expect(container.textContent).not.toContain(DENIED_TITLE);
    });

    test("denied shows absence with its receipt and the scope to re-grant", async () => {
      const container = await mount({
        ...BARE,
        vaultDenied: { code: "consent_denied", message: "rcp_9114" },
      });
      expect(container.textContent).toContain(DENIED_TITLE);
      expect(container.textContent).toContain(DENIED_BODY);
      expect(container.textContent).toContain(DENIED_REGRANT);
      expect(container.textContent).toContain(DENIED_SCOPE);
      expect(container.textContent).toContain("rcp_9114");
      expect(container.textContent).not.toContain(DAY_ONE);
      expect(container.querySelector("nav")).toBeNull();
    });

    test("denied states WHEN the grant went, where the denial carried a time", async () => {
      const container = await mount({
        ...BARE,
        vaultDenied: {
          code: "consent_denied",
          message: "rcp_9114",
          revoked_at: "09:02",
        },
      });
      expect(container.textContent).toContain(
        "The grant was revoked at 09:02."
      );
    });

    test("denied invents no time where the denial carried none", async () => {
      const container = await mount({
        ...BARE,
        vaultDenied: {
          code: "consent_denied",
          message: "rcp_9114",
          revoked_at: null,
        },
      });
      expect(container.textContent).not.toContain("revoked at");
      expect(container.textContent).toContain(
        "The grant is gone, and the time it went with it."
      );
    });
  });

  describe("a write that has not settled speaks", () => {
    test("the count of queued writes, with the way to them", async () => {
      const container = await mount(DASHBOARD, [
        { status: "queued" },
        { status: "queued" },
      ]);
      expect(sentences(container)).toContain(pendingNotice(2));
      expect(buttonNamed(container, VERBS.waiting)).toBeDefined();
    });

    test("a parked steward act names itself and deep-links to Waiting", async () => {
      const container = await mount(DASHBOARD, [{ status: "parked" }]);
      expect(sentences(container)).toContain(PARKED_NOTICE);
      expect(buttonNamed(container, VERBS.review)).toBeDefined();
    });

    test("nothing in flight, no notice — an empty banner is chrome", async () => {
      const container = await mount(DASHBOARD);
      expect(container.querySelector(".kit-banner")).toBeNull();
    });
  });

  describe("offline is a state the app reads, never one it invents", () => {
    test("a host that says the gateway is down names the one exception, and the lag", async () => {
      const container = await mount(DASHBOARD);
      expect(container.textContent).not.toContain(OFFLINE_NOTICE);

      hostEl!.dataset.gatewayStatus = "down";
      await settle(() => window.dispatchEvent(new Event("focus")));

      expect(container.textContent).toContain(OFFLINE_NOTICE);
      const clock = /(?<at>\d{2}:\d{2})/u;
      const stale = sentences(container).find((text) => {
        const at = clock.exec(text)?.groups?.at;
        return at !== undefined && text === staleNotice(at);
      });
      expect(stale).toBeTypeOf("string");
      expect(buttonNamed(container, VERBS.refresh)).toBeDefined();
      expect(hostEl?.dataset.gatewayStatus).toBe("down");
    });

    test("a host that says the gateway is up withholds both", async () => {
      const container = await mount(DASHBOARD);
      hostEl!.dataset.gatewayStatus = "up";
      await settle(() => window.dispatchEvent(new Event("focus")));
      expect(container.textContent).not.toContain(OFFLINE_NOTICE);
    });

    test("the orchestrator reads the verdict rather than inventing one", () => {
      expect(SOURCE).toContain("libraryReachability({");
      expect(SOURCE).toContain("rootElRef.current?.dataset.gatewayStatus");
      expect(SOURCE).toMatch(/readFailed: ledger\.readFailed/u);
      expect(SOURCE).not.toContain("navigator.onLine");
    });
  });

  describe("the room stands under one sentence", () => {
    test("Balances declares what a figure on it IS", async () => {
      const said: string[] = [];
      (window as unknown as { centraid: unknown }).centraid = {
        read: () => Promise.resolve(DASHBOARD),
        commonsIntents: () => Promise.resolve([]),
      };
      const container = document.createElement("div");
      document.body.append(container);
      reactRoot = createRoot(container);
      await act(async () => {
        reactRoot?.render(
          createElement(Root, {
            rootRef: () => undefined,
            frame: {
              ...NO_FRAME,
              setStatus: (text: string) => said.push(text),
            },
          })
        );
      });
      expect(said).toContain(BALANCES_STATUS);
    });
  });
});
// @vitest-environment jsdom
