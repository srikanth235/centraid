// @vitest-environment jsdom
/*
 * THE PHONE'S SCREEN READS, AS PAGES (#996 wave 4b, R8).
 *
 * `useReplicaQuery` with `acceptTruncation` asked the old store for an entity
 * and took whatever window the reader happened to have. This is the hook that
 * replaces those reads, and what it must get right is what the flag never
 * stated: the walk reaches the END of the set, the fan-out bound is a stated
 * ceiling that THROWS rather than a short list that reads as a whole one, a
 * change to another entity does not re-run this read, and a phone with no copy
 * of the vault says so rather than claiming an empty set.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageQuery } from "@centraid/core/page";
import { forEachSequentially } from "@centraid/test-kit/sequential";

import { mountBlock } from "../../test/react-native-stub";
import type { ReplicaContextValue } from "../replica/replica-context";

const hosts = () => import("../../test/react-native-stub");

vi.mock(
  import("react-native"),
  async () =>
    (
      await hosts()
    ).reactNativeStub() as unknown as typeof import("react-native")
);
vi.mock(
  import("@react-native-async-storage/async-storage"),
  async () =>
    (await hosts()).asyncStorageStub() as unknown as {
      default: typeof import("@react-native-async-storage/async-storage").default;
    }
);

interface Row {
  task_id: string;
  created_at: string;
}

/** Every statement the seat was asked to run, in order. */
const statements: Array<{ name: string; after?: string }> = [];
let listeners: Array<(invalidations: readonly unknown[]) => void> = [];
/** How many rows the fake file holds; the page walks it in threes. */
let libraryRows = 7;
let seatPresent = true;

const PAGE_ROWS = 3;

function fakePage(request: {
  query: PageQuery<object>;
  limit: number;
  after?: { sortKey: string; pk: string };
}): Promise<{ rows: Row[]; next?: { sortKey: string; pk: string } }> {
  statements.push({
    name: request.query.name,
    ...(request.after ? { after: request.after.pk } : {}),
  });
  const start = request.after ? Number(request.after.pk.slice(1)) + 1 : 0;
  const size = Math.min(PAGE_ROWS, request.limit);
  const rows: Row[] = [];
  for (let index = start; index < Math.min(start + size, libraryRows); index++)
    rows.push({ task_id: `t${String(index)}`, created_at: `2026-01-0${"1"}` });
  const last = rows.at(-1);
  const next =
    last && start + size < libraryRows
      ? { sortKey: last.created_at, pk: last.task_id }
      : undefined;
  return Promise.resolve({ rows, ...(next ? { next } : {}) });
}

const REPLICA = {
  ready: true,
  reachability: "current" as const,
  scopes: [],
  get seat() {
    return seatPresent ? { page: fakePage } : undefined;
  },
  session: {
    subscribe: (
      _appId: string,
      listener: (invalidations: readonly unknown[]) => void
    ) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    },
  },
};

vi.mock(import("../replica/ReplicaProvider"), () => ({
  useReplica: () => REPLICA as unknown as ReplicaContextValue,
}));

const { useSeatPages } = await import("./useSeatPages");

const TASKS: PageQuery = {
  name: "phone.tasks",
  select: "task_id, created_at",
  from: "schedule_task",
  order: { sortColumn: "created_at", pkColumn: "task_id", descending: true },
};

function Board(props: {
  bound?: { pageSize: number; fanOutPages: number };
}): React.JSX.Element {
  const state = useSeatPages("tasks", TASKS, {
    entity: "schedule.task",
    rowIdColumn: "task_id",
    ...(props.bound ? { bound: props.bound } : {}),
  });
  return (
    <span data-testid="board">
      {`${state.connection}|${String(state.rows.length)}|${state.rows
        .map((row) => String(row["__rowId"]))
        .join(",")}|${state.error ?? ""}`}
    </span>
  );
}

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function settle(): Promise<void> {
  await forEachSequentially([0, 0, 0, 0, 0, 160], (ms) => tick(ms));
}

function boardText(container: HTMLElement): string {
  return container.querySelector("[data-testid='board']")?.textContent ?? "";
}

describe("a screen read as a page over the seat", () => {
  afterEach(() => {
    statements.length = 0;
    listeners = [];
    libraryRows = 7;
    seatPresent = true;
  });

  it("walks to the end of the set rather than taking one window", async () => {
    const { container, unmount } = mountBlock(<Board />);
    await settle();
    expect(boardText(container)).toBe("current|7|t0,t1,t2,t3,t4,t5,t6|");
    // Three pages, each continuing from the last row of the one before — a
    // keyset walk, never an offset.
    expect(statements).toStrictEqual([
      { name: "phone.tasks" },
      { name: "phone.tasks", after: "t2" },
      { name: "phone.tasks", after: "t5" },
    ]);
    unmount();
  });

  it("throws at the stated fan-out bound instead of a short list", async () => {
    libraryRows = 500;
    const { container, unmount } = mountBlock(
      <Board bound={{ pageSize: PAGE_ROWS, fanOutPages: 2 }} />
    );
    await settle();
    expect(boardText(container)).toContain(
      "phone.tasks: fan-out passed 6 rows"
    );
    unmount();
  });

  it("re-runs on its own entity and on a purge, never on another's", async () => {
    const { unmount } = mountBlock(<Board />);
    await settle();
    statements.length = 0;
    for (const listener of listeners.slice())
      listener([{ entity: "core.place", shapeId: "s", source: "overlay" }]);
    await settle();
    expect(statements).toStrictEqual([]);
    for (const listener of listeners.slice())
      listener([{ entity: "schedule.task", shapeId: "s", source: "overlay" }]);
    await settle();
    expect(statements).toHaveLength(3);
    statements.length = 0;
    for (const listener of listeners.slice())
      listener([{ entity: "core.place", shapeId: "s", source: "purge" }]);
    await settle();
    expect(statements).toHaveLength(3);
    unmount();
  });

  it("a phone with no copy of the vault says so, never an empty set", async () => {
    seatPresent = false;
    const { container, unmount } = mountBlock(<Board />);
    await settle();
    expect(boardText(container)).toBe("unavailable|0||");
    expect(statements).toStrictEqual([]);
    unmount();
  });
});
