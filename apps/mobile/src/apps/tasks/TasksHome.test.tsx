import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { StyleSheet } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@centraid/blueprints/apps/tasks/types";
import type { ReplicaRow } from "@centraid/client/replica/native";

import { resolveTheme } from "../../kit/theme";
import { REPLICA_CAN_WRITE } from "../../lib/replica/multi-vault-provenance";
import TaskRow from "./TaskRow";
import { TASKS_BAND_DESTINATIONS } from "./tasks-band";
import { flattenGroups, groupsFor, windowItems } from "./tasks-groups";
import TasksHome from "./TasksHome";
import { makeTasksStyles } from "./TasksHome.styles";
import TasksRows from "./TasksRows";
import TasksToolbar from "./TasksToolbar";

type SeededRow = ReplicaRow & { __rowId: string };

const replicaRows = vi.hoisted(() => ({
  byEntity: new Map<string, SeededRow[]>(),
}));

vi.mock(import("../../kit/replica/ReplicaProvider"), () => ({
  useReplica: vi.fn<
    (typeof import("../../kit/replica/ReplicaProvider"))["useReplica"]
  >(() => ({
    online: true,
    ready: true,
    refresh: vi.fn<() => Promise<void>>(async () => undefined),
    scopes: [],
  })),
}));

vi.mock(import("../../kit/hooks/useReplicaQuery"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useReplicaQuery: (_appId: string, request: { entity?: string }) => ({
      connection: "current" as const,
      error: undefined,
      loading: false,
      refresh: async () => undefined,
      rows: replicaRows.byEntity.get(request.entity ?? "") ?? [],
    }),
  };
});

const NOW = "2026-08-30T09:00:00.000Z";
const styles = makeTasksStyles(resolveTheme("light").colors);

function task(
  id: string,
  title: string,
  extra: Record<string, unknown> = {}
): Task {
  return {
    created_at: "2026-08-01T09:00:00.000Z",
    due_at: "2026-08-30",
    status: "needs-action",
    task_id: id,
    title,
    ...extra,
  } as Task;
}

function itemsFor(tasks: readonly Task[], limit: number) {
  const groups =
    groupsFor({
      now: NOW,
      place: "today",
      projectName: () => "Inbox",
      tasks,
    }) ?? [];
  return windowItems(flattenGroups(groups), limit);
}

function renderRows(
  tasks: readonly Task[],
  overrides: Partial<React.ComponentProps<typeof TasksRows>> = {},
  limit = 50
) {
  const windowed = itemsFor(tasks, limit);
  const noop = vi.fn<() => void>();
  return render(
    <TasksRows
      place="today"
      items={windowed.items}
      shown={windowed.shown}
      total={windowed.total}
      now={NOW}
      styles={styles}
      loading={false}
      dayOne={tasks.length === 0}
      moving={null}
      projectName={() => null}
      onToggle={noop}
      onOpen={noop}
      onPickUp={noop}
      onMoveAll={noop}
      onShowMore={noop}
      onRefresh={noop}
      {...overrides}
    />
  );
}

describe("Tasks, on the real React Native host tree", () => {
  beforeEach(() => {
    replicaRows.byEntity.clear();
    for (const entity of [
      "schedule.task",
      "schedule.project",
      "schedule.section",
    ])
      replicaRows.byEntity.set(entity, []);
  });

  it("mounts the whole route, band included, over the real glyph registry", () => {
    const screen = render(
      <TasksHome
        navigation={{ navigate: vi.fn<() => void>() } as never}
        route={{ params: {} } as never}
      />
    );

    expect(
      TASKS_BAND_DESTINATIONS.filter(
        (destination) => screen.queryAllByText(destination.label).length > 0
      )
    ).toHaveLength(TASKS_BAND_DESTINATIONS.length);
  });

  it("publishes each row as a native checkbox carrying its own checked trait", () => {
    const screen = renderRows([task("t1", "Renew the passport")]);

    expect(
      screen.getByRole("checkbox", { name: "Renew the passport" }).props
    ).toMatchObject({ accessibilityState: { checked: false } });

    const closed = render(
      <TaskRow
        task={task("t2", "File the receipts", { status: "completed" })}
        now={NOW}
        styles={styles}
        projectName={null}
        onToggle={vi.fn<() => void>()}
        onOpen={vi.fn<() => void>()}
        onPickUp={vi.fn<() => void>()}
      />
    );
    expect(
      closed.getByRole("checkbox", { name: "File the receipts" }).props
    ).toMatchObject({ accessibilityState: { checked: true } });
  });

  it("routes a check-off through the real Pressable responder tree", () => {
    const onToggle = vi.fn<(row: Task) => void>();
    const screen = renderRows([task("t1", "Renew the passport")], { onToggle });

    fireEvent.press(
      screen.getByRole("checkbox", { name: "Renew the passport" })
    );
    expect(onToggle.mock.calls.map(([row]) => row.task_id)).toStrictEqual([
      "t1",
    ]);
  });

  it("refuses the press on a read-only row rather than merely dimming it", () => {
    const onToggle = vi.fn<(row: Task) => void>();
    const screen = renderRows(
      [task("t1", "Held by another vault", { [REPLICA_CAN_WRITE]: false })],
      { onToggle }
    );

    const box = screen.getByRole("checkbox", { name: "Held by another vault" });
    expect(box.props).toMatchObject({
      accessibilityHint:
        "This vault is read-only for you, so meaning cannot be written into it.",
      accessibilityState: { disabled: true },
    });
    fireEvent.press(box);
    expect(onToggle.mock.calls).toStrictEqual([]);
  });

  it("draws only the windowed rows and offers the foot that widens the window", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      task(`t${index}`, `Task ${String(index).padStart(2, "0")}`)
    );
    const onShowMore = vi.fn<() => void>();
    const screen = renderRows(many, { onShowMore }, 20);

    expect(screen.queryAllByLabelText("Task 00").length).toBeGreaterThan(0);
    expect(screen.queryAllByLabelText("Task 59")).toHaveLength(0);
    fireEvent.press(screen.getByRole("button", { name: "Show more" }));
    expect(onShowMore.mock.calls).toStrictEqual([[]]);
  });

  it("says the day-one line through FlatList's empty slot, not an empty list", () => {
    const screen = renderRows([]);
    expect(
      screen.getByText("Add the first thing you must not forget.").props
        .children
    ).toBe("Add the first thing you must not forget.");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("keeps a lit lens legible as a selected trait AND as a flattened style", () => {
    const screen = render(
      <TasksToolbar
        count={3}
        unit="tasks"
        lenses={["mine"]}
        sort="priority"
        styles={styles}
        onLens={vi.fn<React.ComponentProps<typeof TasksToolbar>["onLens"]>()}
        onSort={vi.fn<() => void>()}
      />
    );

    const chips = screen
      .getAllByRole("button")
      .filter(
        (node) =>
          (node.props as { accessibilityState?: { selected?: boolean } })
            .accessibilityState?.selected !== undefined
      );
    const lit = chips.filter(
      (node) =>
        (node.props as { accessibilityState: { selected?: boolean } })
          .accessibilityState.selected === true
    );
    expect(lit).toHaveLength(1);
    const dark = chips.find((node) => !lit.includes(node));
    expect(StyleSheet.flatten(lit[0]?.props.style).backgroundColor).not.toBe(
      StyleSheet.flatten(dark?.props.style).backgroundColor
    );
  });
});
