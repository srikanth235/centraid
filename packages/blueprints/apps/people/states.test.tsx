// @vitest-environment jsdom
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
    expect(
      buttons(container).map((button) => button.textContent?.trim())
    ).toStrictEqual([VERBS.addPerson]);
  });

  test("the first run's commit is the route's own onAddPerson", async () => {
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
    expect(container.querySelectorAll(".kit-skeleton")).toHaveLength(6);
    const text = container.textContent ?? "";
    expect(text).not.toContain(FIRST_RUN.title);
    expect(text).not.toContain(FIRST_RUN.body);
  });

  test("a filter that matched nothing is a sentence, never the first run", async () => {
    const container = await mountRoster({
      loading: false,
      people: [person(), person({ party_id: "party-ravi", name: "Ravi" })],
      filter: "starred",
    });
    const text = container.textContent ?? "";
    expect(text).toContain(EMPTY.noMatch);
    expect(text).not.toContain(FIRST_RUN.title);
    expect(text).not.toContain(FIRST_RUN.body);
    expect(
      buttons(container).some((button) => button.textContent?.trim() === "★")
    ).toBe(true);
  });
});

interface Drive {
  sent: { action: string; input: Record<string, unknown> }[];
  status: { text: string; hasUndo: boolean }[];
  cleared: number;
  refreshed: number;
  held: number;
}

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
    expect(drive.held).toBe(1);
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
    expect(container.textContent).toContain("Priya");
    act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
  });

  test("only a landed write earns the outcome sentence and its Undo", async () => {
    const drive = await driveStar({ status: "executed" });
    expect(drive.status).toStrictEqual([
      { text: OUTCOMES.starred("Priya"), hasUndo: true },
    ]);
    expect(drive.refreshed).toBe(1);
  });
});
