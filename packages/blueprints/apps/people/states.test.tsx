// @vitest-environment jsdom
//
// PEOPLE'S APP-STATE CELLS (#864): `people.dayone`, `people.pending`,
// `people.parked`.
//
// Three of the matrix's seven states have an owner in People's own tree, and
// this file is it. Each is asserted at the layer that OWNS the state, which is
// not the same layer for all three:
//
//   dayone   — a RENDER state. `RosterRoute` decides between the skeleton, the
//              whole-app first run and the filter's own sentence, so the claim
//              is made against the rendered tree.
//   pending  — a STATUS-LINE state AND a per-row one. A queued write is
//              narrated by `settle()` on the frame's one status line, and the
//              row the outbox projected wears the shared pending chip, so the
//              cell is both sentences together.
//   parked   — the same status line, one status along. A park, a queue, a
//              denial and a failure are four different facts about the
//              member's data and `refusal()` keeps four sentences; the cell is
//              worth owning only if all four are distinguishable, so all four
//              are asserted here together.
//
// WHAT THIS FILE DELIBERATELY DOES NOT OWN. `people.offline` and
// `people.stale` have no product surface to assert:
//   * `RouteBase.offline` is threaded into every People route's props and read
//     by NONE of them — no route branches on it.
//   * `REFUSALS.readFailed` ("The vault is out of reach.") is referenced by no
//     module in the app.
// A test written against either would be asserting a prop nobody reads. They
// stay gaps against #864 until the surface exists.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import type { InlineFrame } from "../inline-types.ts";
import { RosterRoute } from "./components/RosterRoute.tsx";
import { EMPTY, FIRST_RUN, OUTCOMES, REFUSALS, VERBS } from "./people-copy.ts";
import type { PersonRow, RosterFilter } from "./types.ts";
import { createWrites } from "./writes.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------- day one

let root: Root | undefined;

function person(overrides: Partial<PersonRow> = {}): PersonRow {
  return {
    party_id: "party-priya",
    name: "Priya",
    role: "architect",
    avatar_color: null,
    cadence_days: 30,
    last_contacted_at: null,
    created_at: "2026-08-01T10:00:00.000Z",
    list_id: null,
    starred: false,
    reminders: [],
    ...overrides,
  };
}

async function mountRoster(
  props: {
    loading?: boolean;
    people?: readonly PersonRow[];
    filter?: RosterFilter;
    onAddPerson?: () => void;
  } = {}
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(RosterRoute, {
        loading: props.loading ?? false,
        offline: false,
        narrow: false,
        people: props.people ?? [],
        linksAvailable: true,
        filter: props.filter ?? "all",
        onSelectFilter: () => undefined,
        onOpenPerson: () => undefined,
        onToggleStar: () => undefined,
        onAddPerson: props.onAddPerson ?? (() => undefined),
      })
    );
  });
  return container;
}

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")];
}

describe("people.dayone — the roster with nothing in it", () => {
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
  });

  test("an empty roster past the loading gate is the whole-app first run", async () => {
    const container = await mountRoster({ loading: false, people: [] });
    const text = container.textContent ?? "";
    expect(text).toContain(FIRST_RUN.title);
    expect(text).toContain(FIRST_RUN.body);
    // ONE COMMIT, and it is the only button on the screen: the first run is
    // the single moment People offers a way forward out of nothing, and a
    // second control here would be a second way forward into the same form.
    expect(
      buttons(container).map((button) => button.textContent?.trim())
    ).toStrictEqual([VERBS.addPerson]);
  });

  test("the first run's commit is the route's own onAddPerson", async () => {
    // Record each invocation rather than asserting on a mock: one entry per
    // press, so `toStrictEqual` names the exact commit count the same way it
    // would name the exact command a write sent.
    const added: "add"[] = [];
    const container = await mountRoster({
      loading: false,
      people: [],
      onAddPerson: () => added.push("add"),
    });
    await act(async () => {
      buttons(container)[0]?.click();
    });
    expect(added).toStrictEqual(["add"]);
  });

  test("nothing is empty until a read has landed", async () => {
    const container = await mountRoster({ loading: true, people: [] });
    // The skeleton is the answer while `loading` is set, and the first run's
    // copy must not be anywhere on screen: "you have nobody" is a claim about
    // the vault, and no read has come back to support it yet.
    expect(container.querySelectorAll(".kit-skeleton")).toHaveLength(6);
    const text = container.textContent ?? "";
    expect(text).not.toContain(FIRST_RUN.title);
    expect(text).not.toContain(FIRST_RUN.body);
  });

  test("a filter that matched nothing is a sentence, never the first run", async () => {
    // The member HAS people; the chip they just pressed is why the list is
    // empty, so the way forward is that chip and not a display head offering
    // to add somebody.
    const container = await mountRoster({
      loading: false,
      people: [person(), person({ party_id: "party-ravi", name: "Ravi" })],
      filter: "starred",
    });
    const text = container.textContent ?? "";
    expect(text).toContain(EMPTY.noMatch);
    expect(text).not.toContain(FIRST_RUN.title);
    expect(text).not.toContain(FIRST_RUN.body);
    // The chips are still drawn — the way off the filter has to stay reachable.
    expect(
      buttons(container).some((button) => button.textContent?.trim() === "★")
    ).toBe(true);
  });
});

// ------------------------------------------------- pending / parked / …

/** What one drive of a write recorded: the command it sent and every sentence
 *  the frame's single status line was given. */
interface Drive {
  sent: { action: string; input: Record<string, unknown> }[];
  status: { text: string; hasUndo: boolean }[];
  cleared: number;
  refreshed: number;
  held: number;
}

/**
 * Toggle a star with `window.centraid.write` answering `outcome`, and report
 * everything observable afterwards.
 *
 * `toggleStar` is the smallest write in the app and takes the same `settle()`
 * path every other one does, so the outcome sentences it produces are the
 * whole app's.
 */
async function driveStar(outcome: VaultOutcome | undefined): Promise<Drive> {
  const drive: Drive = {
    sent: [],
    status: [],
    cleared: 0,
    refreshed: 0,
    held: 0,
  };
  (window as unknown as { centraid: unknown }).centraid = {
    write: (command: {
      action: string;
      input: Record<string, unknown>;
      intentId: string;
    }) => {
      drive.sent.push({ action: command.action, input: command.input });
      return Promise.resolve(outcome);
    },
  };
  const frame: InlineFrame = {
    setAppBar: () => undefined,
    setStatus: (text, extra) => {
      drive.status.push({ text, hasUndo: Boolean(extra?.action) });
    },
    clearStatus: () => {
      drive.cleared += 1;
    },
    claimBand: () => undefined,
  };
  const writes = createWrites({
    frame,
    refresh: () => {
      drive.refreshed += 1;
      return Promise.resolve();
    },
    hold: () => {
      drive.held += 1;
    },
    notice: () => undefined,
  });
  await writes.toggleStar({
    party_id: "party-priya",
    name: "Priya",
    starred: false,
  });
  return drive;
}

describe("people.pending / people.parked — the frame's one status line", () => {
  afterEach(() => {
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  test("a queued write says so, and re-reads the roster it projected into", async () => {
    const drive = await driveStar({ status: "queued" });
    expect(drive.sent).toStrictEqual([
      { action: "star-person", input: { party_id: "party-priya" } },
    ]);
    expect(drive.status).toStrictEqual([
      { text: REFUSALS.queued, hasUndo: false },
    ]);
    // `hold()` is what keeps the route's ambient sentence from overwriting the
    // queue notice on the next render, so it runs before the branch.
    expect(drive.held).toBe(1);
    // A QUEUED WRITE IS DURABLE, so the roster is re-read: the row comes back
    // carrying `pending-projection.ts`'s optimistic values and its chip. What
    // it does NOT earn is the outcome sentence or an Undo.
    expect(drive.refreshed).toBe(1);
  });

  test("an in-flight write is the same fact as a queued one", async () => {
    const drive = await driveStar({ status: "in-flight" });
    expect(drive.status).toStrictEqual([
      { text: REFUSALS.queued, hasUndo: false },
    ]);
    expect(drive.refreshed).toBe(1);
  });

  test("a parked write waits for approval, in its own words", async () => {
    const drive = await driveStar({ status: "parked" });
    expect(drive.status).toStrictEqual([
      { text: REFUSALS.parked, hasUndo: false },
    ]);
    expect(drive.refreshed).toBe(0);
  });

  test("park, queue, denial and failure are four distinguishable sentences", async () => {
    // The cell is only worth owning if the member can tell them apart: a write
    // waiting for the owner's approval and a write sitting in this device's
    // outbox are different facts about their data, and an unknown terminal
    // status must not be dressed as either.
    // Driven one at a time on purpose: `window.centraid` is ONE door, so
    // overlapping drives would answer each other's writes.
    const parked = await driveStar({ status: "parked" });
    const queued = await driveStar({ status: "queued" });
    const denied = await driveStar({ status: "denied" });
    const invented = await driveStar({
      status: "invented-status" as VaultOutcome["status"],
    });
    const nothing = await driveStar(undefined);
    const said = [parked, queued, denied, invented, nothing].map(
      (drive) => drive.status[0]?.text ?? ""
    );
    expect(said).toStrictEqual([
      REFUSALS.parked,
      REFUSALS.queued,
      REFUSALS.denied,
      REFUSALS.failed,
      REFUSALS.failed,
    ]);
    expect(new Set(said).size).toBe(4);
  });

  test("the row a queued add projected wears the shared pending chip", async () => {
    // The status line is one sentence for the whole app; the chip is what says
    // WHICH person is still on this device. `queries/people.ts` forwards the
    // outbox stamps onto the row so the shared component can read them.
    const container = await mountRoster({
      people: [
        person({
          party_id: "pending:add:party",
          name: "Ravi",
          ...({
            __centraid_pending_key: "intent-1",
            __centraid_pending_status: "queued",
            __centraid_pending_action: "add-person",
          } as unknown as Partial<PersonRow>),
        }),
        person(),
      ],
    });
    const chips = [...container.querySelectorAll(".kit-pending-chip")];
    expect(chips.map((chip) => chip.textContent)).toStrictEqual(["queued"]);
    // The settled row is not decorated: a chip on every row says nothing.
    expect(container.textContent).toContain("Priya");
    act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
  });

  test("only a landed write earns the outcome sentence and its Undo", async () => {
    // The contrast that makes the three refusals above mean something: on
    // `executed` the line names what happened, offers the true reverse write,
    // and the roster is re-read.
    const drive = await driveStar({ status: "executed" });
    expect(drive.status).toStrictEqual([
      { text: OUTCOMES.starred("Priya"), hasUndo: true },
    ]);
    expect(drive.refreshed).toBe(1);
  });
});
