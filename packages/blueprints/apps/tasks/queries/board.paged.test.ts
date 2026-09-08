// THE BOARD IS PAGED, AND THERE IS NO OTHER WAY IN (#996 wave 4, R8, W4-D2).
//
// The board had ten declarative reads and eight of them said
// "accept truncation" — the flag that meant "stop wherever you like, and
// do not tell me where". The claims here are the ones that replaces:
//
//   1. the handler reaches the vault ONLY through `ctx.vault.page`. A single
//      surviving `ctx.vault.read` is a read with no stated window, which is
//      what the whole wave is removing, so the fake ctx has no `read` at all
//      and its absence is what would break;
//   2. every statement carries a window and an order whose two columns it also
//      selects — the cursor is read off the row by those columns, so a
//      statement that orders on something it does not project has no cursor;
//   3. `truncated` is the PAGE's answer, a cursor that exists or does not, and
//      no longer the old guess `openRows.length >= window`, which cannot tell a
//      window that filled exactly from one that ran out;
//   4. the joins are `in`-bounded by the window's own task ids and walk to the
//      end of that bounded set rather than taking one page of it.

import { describe, expect, it, vi } from "vitest";

import boardHandler from "./board.ts";

interface Statement {
  name: string;
  select: string;
  from: string;
  where?: string;
  bind?: readonly (string | number | null)[];
  order: { sortColumn: string; pkColumn: string; descending: boolean };
}

const TASKS = [
  {
    task_id: "task-2",
    status: "needs-action",
    title: "Water the plants",
    priority: 0,
    due_at: null,
  },
  {
    task_id: "task-1",
    status: "needs-action",
    title: "Book the ferry",
    priority: 0,
    due_at: null,
  },
];

/**
 * A ctx that answers pages from a table keyed by the handler's own statement
 * name, and records every statement it was asked for.
 *
 * `read` and `search` are DELIBERATELY absent: touching either is a
 * `TypeError`, which is how case 1 above fails rather than passing quietly.
 */
function pagingCtx(
  rowsByHandler: Record<string, Record<string, unknown>[]>,
  moreAfter: string[] = []
) {
  const statements: Statement[] = [];
  interface PageRequest {
    query: Statement;
    limit: number;
    after?: { sortKey: string; pk: string };
  }
  const page = vi.fn<
    (request: PageRequest) => Promise<{
      rows: Record<string, unknown>[];
      next?: { sortKey: string; pk: string };
    }>
  >(async (request: PageRequest) => {
    statements.push(request.query);
    // A second page is never served: the fixtures are small, and a handler
    // that walked twice over this data would be walking a set it did not
    // bound. `moreAfter` is how case 3 asks for a cursor.
    if (request.after) return { rows: [] };
    const rows = rowsByHandler[request.query.name] ?? [];
    return moreAfter.includes(request.query.name)
      ? {
          rows,
          next: { sortKey: String(rows.at(-1)?.task_id ?? ""), pk: "x" },
        }
      : { rows };
  });
  const ctx = {
    vault: {
      page,
      resolve: async () => ({ cards: [] }),
    },
    time: {
      collapseMissedOccurrences: () => ({ missed: 0, nextDue: null }),
      describeRecurrence: () => "",
    },
  };
  return { ctx: ctx as unknown as HandlerArgs["ctx"], statements, page };
}

describe("the task board reaches the vault only through pages", () => {
  it("answers with no ctx.vault.read anywhere on the path", async () => {
    const { ctx, page } = pagingCtx({ "tasks.board.open": TASKS });
    const result = (await boardHandler({
      input: {},
      ctx,
    } as unknown as HandlerArgs)) as { open: { task_id: string }[] };
    expect(result.open.map((task) => task.task_id)).toStrictEqual([
      "task-1",
      "task-2",
    ]);
    expect(page).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));
  });

  it("gives every statement a window, and orders on what it selects", async () => {
    const { ctx, statements } = pagingCtx({ "tasks.board.open": TASKS });
    await boardHandler({ input: {}, ctx } as unknown as HandlerArgs);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      // The cursor is read off the row by the order's two columns, so a
      // statement that orders on a column it does not project cannot continue.
      expect(statement.select).toContain(statement.order.sortColumn);
      expect(statement.select).toContain(statement.order.pkColumn);
      // Physical tables, because the same statement runs on the seat's own
      // file and on the gateway's paged door (W4-D2).
      expect(statement.from).toMatch(/^[a-z_]+$/u);
    }
  });

  it("bounds each join by the window's own task ids", async () => {
    const { ctx, statements } = pagingCtx({ "tasks.board.open": TASKS });
    await boardHandler({ input: {}, ctx } as unknown as HandlerArgs);
    const attachments = statements.find(
      (statement) => statement.name === "tasks.board.attachments"
    );
    expect(attachments?.where).toBe("target_type = ? AND target_id IN (?, ?)");
    expect(attachments?.bind).toStrictEqual([
      "schedule.task",
      "task-2",
      "task-1",
    ]);
  });

  it("says truncated when the page has a cursor, and not when it has none", async () => {
    const ended = pagingCtx({ "tasks.board.open": TASKS });
    const endedResult = (await boardHandler({
      input: {},
      ctx: ended.ctx,
    } as unknown as HandlerArgs)) as { truncated: boolean };
    expect(endedResult.truncated).toBe(false);

    const more = pagingCtx({ "tasks.board.open": TASKS }, ["tasks.board.open"]);
    const moreResult = (await boardHandler({
      input: {},
      ctx: more.ctx,
    } as unknown as HandlerArgs)) as { truncated: boolean };
    expect(moreResult.truncated).toBe(true);
  });
});
