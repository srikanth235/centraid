// @vitest-environment jsdom
// AGENDA'S HONEST STATES (matrix `appStates`, umbrella #864).
//
// Four cells — day one, offline, stale, conflict — proven the only way that
// closes them: the PRODUCTION `Root` is mounted over a stubbed `window.centraid`
// and each state is reached through the app's own derivation, never by
// rendering a copy table or a leaf component in isolation. What every test
// observes is the screen a member would see.
//
// The offline/stale pair also fixes a defect. Until #864 this app decided
// offline with `navigator.onLine`, which `_shared/view-state-kit.ts` forbids in
// so many words: on the desktop the gateway is a local child process, so a
// machine with no network reaches it perfectly well and the banner was simply
// untrue. The repair routes those two lines through `libraryReachability`, and
// the wiring block at the bottom is what keeps `navigator.onLine` from coming
// back.
import { readFileSync } from "node:fs";
import path from "node:path";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { decoratePendingMutation } from "../_shared/pending-overlay.ts";
import type { InlineFrame } from "../inline-types.ts";
import { Root } from "./app-root.tsx";
import type { AgEvent } from "./types.ts";
import {
  CANCEL_EVENT,
  NEW_EVENT,
  SAVE,
  STATE_DAY_ONE,
  STATE_DAY_ONE_ACTION,
  STATE_OFFLINE,
  STATE_READ_FAILED,
  STATE_REFRESH,
  STATE_STALE,
} from "./view-copy.ts";

const SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "app-root.tsx"),
  "utf8"
);

/** The calendar every vault has: bootstrap founds one "Personal". */
const CALENDARS = [{ calendar_id: "cal-personal", name: "Personal" }];

interface MountOptions {
  /** What `upcoming` answers. `"reject"` is a read that came back FAILED. */
  events: readonly AgEvent[] | "reject";
  /** The default-view knob, as the host stamps it. */
  view?: string;
  write?: (opts: {
    action: string;
    input?: Record<string, unknown>;
  }) => Promise<unknown>;
  retryPendingWrite?: (key: string, scopeId?: string) => void;
  discardPendingWrite?: (key: string, scopeId?: string) => void;
}

let reactRoot: ReturnType<typeof createRoot> | undefined;

/** The element the host stamps its `data-*` knobs onto — including, once the
 *  shell publishes it, `data-gateway-status`. */
let hostEl: HTMLElement | null = null;

const NO_FRAME: InlineFrame = {
  setAppBar: () => undefined,
  setStatus: () => undefined,
  clearStatus: () => undefined,
  claimBand: () => undefined,
};

async function mount(options: MountOptions): Promise<HTMLDivElement> {
  const read = ({ query }: { query: string }): Promise<unknown> => {
    if (query === "upcoming")
      return options.events === "reject"
        ? Promise.reject(new Error("gateway unreachable"))
        : Promise.resolve({ events: options.events, calendars: CALENDARS });
    if (query === "day-context")
      return Promise.resolve({ birthdays: [], due: [], holidays: [] });
    return Promise.resolve({ parties: [], me: null });
  };
  (window as unknown as { centraid: unknown }).centraid = {
    read,
    write: options.write ?? (async () => ({ status: "executed", output: {} })),
    ...(options.retryPendingWrite
      ? { retryPendingWrite: options.retryPendingWrite }
      : {}),
    ...(options.discardPendingWrite
      ? { discardPendingWrite: options.discardPendingWrite }
      : {}),
  };
  if (options.view)
    document.documentElement.dataset.appDefaultView = options.view;

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

/** Window focus is this app's own sanctioned re-read (`onFocusRefresh`) — the
 *  event-driven way to make it look at the host's knobs again. */
async function refocus(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
}

function buttonNamed(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(
    (button) => button.textContent === label
  );
  expect(found, `no button labelled ${label}`).toBeDefined();
  return found as HTMLButtonElement;
}

/** The mount lifecycle every rendering block below shares. A function, not
 *  file-scope hooks: a hook belongs inside the `describe` it serves. */
function installMountLifecycle(): void {
  beforeAll(() => {
    // jsdom does not implement the dialog's two modal methods at all; the
    // element is otherwise real, so they are defined rather than stubbed over.
    for (const method of ["showModal", "close"] as const)
      Object.defineProperty(HTMLDialogElement.prototype, method, {
        configurable: true,
        value: () => undefined,
      });
  });

  afterEach(() => {
    if (reactRoot) act(() => reactRoot?.unmount());
    reactRoot = undefined;
    hostEl = null;
    document.body.replaceChildren();
    delete document.documentElement.dataset.appDefaultView;
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });
}

// ---------------------------------------------------------------- day one

describe("day one is an empty VAULT, not an empty window", () => {
  installMountLifecycle();

  test("a vault with no events says so and offers the first one", async () => {
    const container = await mount({ events: [] });

    expect(container.querySelector(".kit-empty")?.textContent).toContain(
      STATE_DAY_ONE
    );

    // The action is the app's own create composer, not a dead label: pressing
    // it opens the editor under its New event heading.
    await act(async () => buttonNamed(container, STATE_DAY_ONE_ACTION).click());
    expect(container.querySelector("#agendaEditorTitle")?.textContent).toBe(
      NEW_EVENT
    );
  });

  test("an empty VIEW over a stocked vault is never day one", async () => {
    // Waiting on holds only events still owed an answer; this one is answered,
    // so the view is empty while the vault is not.
    const container = await mount({
      view: "waiting",
      events: [
        {
          event_id: "ev-answered",
          calendar_id: "cal-personal",
          summary: "Site visit",
          dtstart: new Date().toISOString(),
          attendees: [
            {
              party_id: "party-me",
              name: "You",
              partstat: "accepted",
              is_you: true,
            },
          ],
        },
      ],
    });

    const empty = container.querySelector(".kit-empty");
    expect(empty?.textContent).toContain("Nothing is waiting on your answer.");
    expect(empty?.textContent).not.toContain(STATE_DAY_ONE);
  });

  test("a refused create keeps the typed draft", async () => {
    const container = await mount({
      events: [],
      write: async () => ({
        status: "failed",
        predicate: "no_busy_conflict: overlap",
      }),
    });
    await act(async () => buttonNamed(container, STATE_DAY_ONE_ACTION).click());
    const title =
      container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(title).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set?.call(title, "Site visit");
      title!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonNamed(container, SAVE).click());
    expect(container.querySelector("#agendaEditorTitle")?.textContent).toBe(
      NEW_EVENT
    );
    expect(
      container.querySelector<HTMLInputElement>('input[type="text"]')?.value
    ).toBe("Site visit");
  });
});

// -------------------------------------------------------- offline + stale

describe("offline and stale are READ from the host, never invented", () => {
  installMountLifecycle();

  test("a host that says the gateway is down draws both lines", async () => {
    const container = await mount({ events: [] });
    // Nothing to declare while the vault answers: an empty state row is chrome,
    // so the app draws none.
    expect(container.textContent).not.toContain(STATE_OFFLINE);

    hostEl!.dataset.gatewayStatus = "down";
    await refocus();

    expect(container.textContent).toContain(STATE_OFFLINE);
    expect(container.textContent).toContain(STATE_STALE);
    // Offline is not an error: the read landed, so the failure line stays away.
    expect(container.textContent).not.toContain(STATE_READ_FAILED);
  });

  test("a host that says the gateway is up withholds both lines", async () => {
    const container = await mount({ events: [] });
    hostEl!.dataset.gatewayStatus = "up";
    await refocus();

    expect(container.textContent).not.toContain(STATE_OFFLINE);
    expect(container.textContent).not.toContain(STATE_STALE);
  });

  test("a read that came back FAILED outranks both, with the way back", async () => {
    const container = await mount({ events: "reject" });

    expect(container.textContent).toContain(STATE_READ_FAILED);
    expect(buttonNamed(container, STATE_REFRESH).className).toContain(
      "kit-btn"
    );
    // The sharper sentence wins: "the vault could not be reached" replaces
    // "showing this device's copy" rather than stacking with it.
    expect(container.textContent).not.toContain(STATE_OFFLINE);
    expect(container.textContent).not.toContain(STATE_STALE);
  });
});

// ---------------------------------------------------------------- conflict

describe("conflict names both versions and both ways out", () => {
  installMountLifecycle();

  /** A cancel the vault refused because the row moved underneath it, decorated
   *  by the one shared overlay engine every seat consumes. */
  const CONFLICTED = decoratePendingMutation(
    {
      op: "upsert" as const,
      entity: "core.event",
      rowId: "ev-conflict",
      values: {
        event_id: "ev-conflict",
        calendar_id: "cal-personal",
        summary: "Site visit",
        dtstart: new Date().toISOString(),
      },
    },
    {
      intentId: "agenda-cancel-site-visit",
      state: "conflict",
      action: "cancel-event",
      conflict: { expectedVersion: 4, actualVersion: 7 },
    }
  ).values as unknown as AgEvent;

  test("the detail panel reports the versions and offers retry and discard", async () => {
    // The outbox doors record what reached them, so the assertion below is the
    // OUTCOME the presses produced — which doors, in which order, with which
    // arguments — rather than the fact that a mock ran.
    const outbox: string[] = [];
    const container = await mount({
      view: "schedule",
      events: [CONFLICTED],
      retryPendingWrite: (key, scopeId) =>
        outbox.push(`retry:${key}:${String(scopeId)}`),
      discardPendingWrite: (key, scopeId) =>
        outbox.push(`discard:${key}:${String(scopeId)}`),
    });

    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-event-id="ev-conflict"]')
        ?.click()
    );
    const detail = container.querySelector<HTMLElement>(
      'aside[aria-label="Site visit"]'
    );
    expect(detail).not.toBeNull();
    // The panel is still the EVENT's: the cancel verb stands beside the held
    // write rather than being replaced by it.
    expect(detail?.textContent).toContain(CANCEL_EVENT);

    expect(detail?.querySelector(".kit-pending-chip")?.textContent).toBe(
      "conflict"
    );
    expect(detail?.textContent).toContain("Expected version 4; found 7.");

    // Both ways out, each wired to the shell's own outbox door. Agenda is a
    // single-scope mount, so no scope id rides along.
    await act(async () => buttonNamed(detail!, "Retry").click());
    await act(async () => buttonNamed(detail!, "Discard").click());
    expect(outbox).toStrictEqual([
      "retry:agenda-cancel-site-visit:undefined",
      "discard:agenda-cancel-site-visit:undefined",
    ]);
  });
});

// ----------------------------------------------------------------- wiring
//
// A rule nobody calls is a rule that does not hold. These read the
// orchestrator as text and pin the two gates the renders above walked through,
// so neither can be quietly re-decided somewhere else.

describe("the orchestrator is wired to these rules", () => {
  test("day one is the vault being empty, never the search being empty", () => {
    expect(SOURCE).toMatch(/data\.events\.length === 0 && !searching/u);
    expect(SOURCE).toContain("STATE_DAY_ONE");
    // A search with no matches gets the view's own line and no create verb.
    expect(SOURCE).toMatch(/emptyLine\(view, searching\)/u);
    expect(SOURCE).toMatch(
      /actionLabel=\{searching \? undefined : STATE_DAY_ONE_ACTION\}/u
    );
    // The defect this shape replaced: day one decided by a row count alone.
    expect(SOURCE).not.toMatch(/rows\.length === 0\s*\?\s*STATE_DAY_ONE/u);
  });

  test("offline is the reachability verdict, never navigator.onLine", () => {
    expect(SOURCE).toContain("libraryReachability({");
    expect(SOURCE).toContain("rootElRef.current?.dataset.gatewayStatus");
    expect(SOURCE).toMatch(/readFailed: readFailedState/u);
    // The forbidden signal (_shared/view-state-kit.ts): a desktop with no
    // network still reaches its local gateway.
    expect(SOURCE).not.toContain("navigator.onLine");
    // Precedence, as the state row expresses it.
    expect(SOURCE).toMatch(/offline && !readFailedState/u);
  });
});
