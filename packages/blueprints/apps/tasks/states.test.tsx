// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";

import { decoratePendingMutation } from "../_shared/pending-overlay.ts";
import type { InlineFrame } from "../inline-types.ts";
import { Root } from "./app-root.tsx";
import { Notices } from "./components/States.tsx";
import { TaskRow } from "./components/TaskRow.tsx";
import type { Task } from "./types.ts";
import { REFRESH, staleNotice } from "./view-copy.ts";

const SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "app-root.tsx"),
  "utf8"
);

const NOW = "2026-08-21T10:00:00.000Z";

const OPEN_TASK: Task = {
  task_id: "task-passport",
  status: "needs-action",
  title: "Renew the passport",
  due_at: "2026-08-25T09:00:00.000Z",
};

describe("stale is the reachability verdict, reaching the board", () => {
  const NO_FRAME: InlineFrame = {
    setAppBar: () => undefined,
    setStatus: () => undefined,
    clearStatus: () => undefined,
    claimBand: () => undefined,
  };

  let reactRoot: ReturnType<typeof createRoot> | undefined;
  let hostEl: HTMLElement | null = null;

  afterEach(() => {
    if (reactRoot) act(() => reactRoot?.unmount());
    reactRoot = undefined;
    hostEl = null;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  async function mount(): Promise<HTMLDivElement> {
    (window as unknown as { centraid: unknown }).centraid = {
      read: ({ query }: { query: string }) =>
        query === "board"
          ? Promise.resolve({
              open: [OPEN_TASK],
              logbook: [],
              projects: [],
              sections: [],
              tags: [],
              counts: {},
              window: 500,
            })
          : Promise.resolve({}),
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

  function staleSentence(container: HTMLElement): string | undefined {
    const clock = /(?<at>\d{2}:\d{2})/u;
    return [...container.querySelectorAll("span")]
      .map((span) => span.textContent ?? "")
      .find((text) => {
        const at = clock.exec(text)?.groups?.at;
        return at !== undefined && text === staleNotice(at);
      });
  }

  test("a host that says the gateway is down raises the notice", async () => {
    const container = await mount();
    expect(staleSentence(container)).toBeUndefined();

    hostEl!.dataset.gatewayStatus = "down";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(staleSentence(container)).toBeTypeOf("string");
    const refresh = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === REFRESH
    );
    expect(refresh).toBeDefined();
    expect(hostEl?.dataset.gatewayStatus).toBe("down");
  });

  test("a host that says the gateway is up withholds it", async () => {
    const container = await mount();
    hostEl!.dataset.gatewayStatus = "up";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(staleSentence(container)).toBeUndefined();
  });

  test("the notice block states the lag and offers the way to close it", () => {
    const markup = renderToStaticMarkup(
      createElement(Notices, {
        absence: null,
        onCatchUp: () => undefined,
        staleAt: "08:02",
        onRefresh: () => undefined,
      })
    );
    expect(markup).toContain(staleNotice("08:02"));
    expect(markup).toContain(REFRESH);
  });

  test("no lag, no notice — an empty banner is chrome", () => {
    const markup = renderToStaticMarkup(
      createElement(Notices, {
        absence: null,
        onCatchUp: () => undefined,
        staleAt: null,
        onRefresh: () => undefined,
      })
    );
    expect(markup).toBe("");
  });

  test("the orchestrator reads the verdict rather than inventing one", () => {
    expect(SOURCE).toContain("libraryReachability({");
    expect(SOURCE).toContain("rootElRef.current?.dataset.gatewayStatus");
    expect(SOURCE).toMatch(/readFailed: readFailedState/u);
    expect(SOURCE).not.toContain("navigator.onLine");
    expect(SOURCE).toMatch(
      /staleAt=\{reach === "unreachable" \? now\.slice\(11, 16\) : null\}/u
    );
    expect(SOURCE).toMatch(
      /data-gateway-status=\{reach === "unreachable" \? "down" : undefined\}/u
    );
  });
});

describe("a held write speaks on the row that carries it", () => {
  const held = (intent: Parameters<typeof decoratePendingMutation>[1]): Task =>
    decoratePendingMutation(
      {
        op: "upsert" as const,
        entity: "schedule.task",
        rowId: OPEN_TASK.task_id,
        values: {
          task_id: OPEN_TASK.task_id,
          status: OPEN_TASK.status,
          title: OPEN_TASK.title,
          due_at: OPEN_TASK.due_at ?? null,
        },
      },
      intent
    ).values as unknown as Task;

  let reactRoot: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (reactRoot) act(() => reactRoot?.unmount());
    reactRoot = undefined;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  async function renderRow(task: Task): Promise<HTMLDivElement> {
    const container = document.createElement("div");
    document.body.append(container);
    reactRoot = createRoot(container);
    await act(async () => {
      reactRoot?.render(
        createElement(TaskRow, {
          task,
          now: NOW,
          onOpen: () => undefined,
          onComplete: () => undefined,
        })
      );
    });
    return container;
  }

  test("parked names the owner's approval and the way to it", async () => {
    const opened: string[] = [];
    (window as unknown as { centraid: unknown }).centraid = {
      openApprovals: () => opened.push("approvals"),
    };
    const container = await renderRow(
      held({
        intentId: "tasks-edit-passport",
        state: "parked",
        action: "edit",
        reason: "Waiting for the owner to approve this change.",
      })
    );

    expect(container.querySelector(".kit-pending-chip")?.textContent).toBe(
      "parked"
    );
    expect(container.textContent).toContain(
      "Waiting for the owner to approve this change."
    );
    const review = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review in Approvals"
    );
    expect(review).toBeDefined();
    await act(async () => review?.click());
    expect(opened).toStrictEqual(["approvals"]);
  });

  test("conflict names both versions and offers retry and discard", async () => {
    const outbox: string[] = [];
    (window as unknown as { centraid: unknown }).centraid = {
      retryPendingWrite: (key: string, scopeId?: string) =>
        outbox.push(`retry:${key}:${String(scopeId)}`),
      discardPendingWrite: (key: string, scopeId?: string) =>
        outbox.push(`discard:${key}:${String(scopeId)}`),
    };
    const container = await renderRow(
      held({
        intentId: "tasks-complete-passport",
        state: "conflict",
        action: "set-status",
        conflict: { expectedVersion: 4, actualVersion: 7 },
      })
    );

    expect(container.querySelector(".kit-pending-chip")?.textContent).toBe(
      "conflict"
    );
    expect(container.textContent).toContain("Expected version 4; found 7.");

    const buttons = [...container.querySelectorAll("button")];
    const retry = buttons.find((button) => button.textContent === "Retry");
    const discard = buttons.find((button) => button.textContent === "Discard");
    expect(retry).toBeDefined();
    expect(discard).toBeDefined();
    await act(async () => {
      retry?.click();
      discard?.click();
    });
    expect(outbox).toStrictEqual([
      "retry:tasks-complete-passport:undefined",
      "discard:tasks-complete-passport:undefined",
    ]);
  });

  test("a settled row draws no held-write block at all", async () => {
    const container = await renderRow(OPEN_TASK);
    expect(container.querySelector(".kit-pending-chip")).toBeNull();
    expect(container.textContent).toContain(OPEN_TASK.title);
  });
});
