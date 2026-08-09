// Tasks' cross-scope board read (issue #726 D11 task 3): the EXIT EVIDENCE
// for "a second app reads over two mounted scopes through the shared kit
// with zero sharing-specific code of its own" — every fact this suite
// checks about ordering/dedupe/tagging is proved once, generically, in
// scope-merge.test.ts; what matters here is that `readBoard` (apps/tasks/
// scope-fanout.ts) actually calls through it rather than re-deriving a
// Tasks-only merge. Loaded by file URL like the other blueprint-app
// fixtures; the module reads `window.centraid` live, so each case installs
// its own stub before importing.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

interface Task {
  task_id: string;
  status: string;
  title: string;
}
interface BoardPayload {
  open?: (Task & { scope_id?: string })[];
  logbook?: Task[];
  counts?: { open?: number };
  [key: string]: unknown;
}
type ScopeRead =
  | { scope: string; ok: true; data: BoardPayload }
  | { scope: string; ok: false; error: { message: string } };

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/tasks/scope-fanout.ts")
).href;
const { readBoard } = (await import(moduleUrl)) as {
  readBoard: (input: Record<string, unknown>) => Promise<BoardPayload>;
};

const task = (id: string): Task => ({
  task_id: id,
  status: "needs-action",
  title: id,
});

/** Install a `window.centraid` with the given scopes and canned answers. */
function mount(
  scopes: { id: string; label: string; canWrite: boolean }[] | undefined,
  handlers: {
    read?: (opts: unknown) => Promise<BoardPayload>;
    readAll?: (opts: { scopes?: readonly string[] }) => Promise<ScopeRead[]>;
  } = {}
): void {
  (globalThis as { window?: unknown }).window = {
    centraid: {
      ...(scopes ? { scopes } : {}),
      read: handlers.read ?? (() => Promise.reject(new Error("no read"))),
      ...(handlers.readAll ? { readAll: handlers.readAll } : {}),
    },
  };
}

describe("Tasks board fan-out (#726 D11 task 3)", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("reads a single-scope host plainly — no fan-out, no merge", async () => {
    let sawScopes = false;
    mount(undefined, {
      read: () => Promise.resolve({ open: [task("a")] }),
      readAll: () => {
        sawScopes = true;
        return Promise.resolve([]);
      },
    });
    const result = await readBoard({ limit: 500 });
    expect(result.open).toStrictEqual([task("a")]);
    expect(sawScopes).toBe(false);
  });

  it("fans out over two mounted scopes and merges through the shared kit", async () => {
    mount(
      [
        { id: "own", label: "Tasks", canWrite: true },
        { id: "family", label: "Family", canWrite: true },
      ],
      {
        readAll: ({ scopes }) => {
          expect(scopes).toStrictEqual(["own", "family"]);
          return Promise.resolve([
            {
              scope: "own",
              ok: true,
              data: { open: [task("o1")], logbook: [task("o-done")] },
            },
            { scope: "family", ok: true, data: { open: [task("f1")] } },
          ]);
        },
      }
    );
    const result = await readBoard({ limit: 500 });
    expect(result.open?.map((t) => t.task_id)).toStrictEqual(["o1", "f1"]);
    expect(result.open?.map((t) => t.scope_id)).toStrictEqual([
      "own",
      "family",
    ]);
    // Non-`open` fields come from the OWN scope's answer.
    expect(result.logbook).toStrictEqual([task("o-done")]);
  });

  it("dedupes a task shared into both scopes, own scope winning", async () => {
    mount(
      [
        { id: "own", label: "Tasks", canWrite: true },
        { id: "family", label: "Family", canWrite: true },
      ],
      {
        readAll: () =>
          Promise.resolve([
            { scope: "own", ok: true, data: { open: [task("shared")] } },
            { scope: "family", ok: true, data: { open: [task("shared")] } },
          ]),
      }
    );
    const result = await readBoard({ limit: 500 });
    expect(result.open).toHaveLength(1);
    expect(result.open?.[0]!.scope_id).toBe("own");
  });

  it("keeps the own scope's tasks when an audience scope fails, and NAMES the failed scope in `reach` rather than silently substituting an empty page (#726 D10/D11)", async () => {
    mount(
      [
        { id: "own", label: "Tasks", canWrite: true },
        { id: "family", label: "Family", canWrite: true },
      ],
      {
        readAll: () =>
          Promise.resolve([
            { scope: "own", ok: true, data: { open: [task("o1")] } },
            { scope: "family", ok: false, error: { message: "denied" } },
          ]),
      }
    );
    const result = await readBoard({ limit: 500 });
    expect(result.open?.map((t) => t.task_id)).toStrictEqual(["o1"]);
    expect(result.reach).toStrictEqual([
      { scope: "own", state: "reached" },
      { scope: "family", state: "unreached", detail: "denied" },
    ]);
  });

  it("reports every fanned-out scope as `reached` when all of them answer — an empty audience list is then a genuine fact, not a masked failure", async () => {
    mount(
      [
        { id: "own", label: "Tasks", canWrite: true },
        { id: "family", label: "Family", canWrite: true },
      ],
      {
        readAll: () =>
          Promise.resolve([
            { scope: "own", ok: true, data: { open: [task("o1")] } },
            { scope: "family", ok: true, data: { open: [] } },
          ]),
      }
    );
    const result = await readBoard({ limit: 500 });
    expect(result.reach).toStrictEqual([
      { scope: "own", state: "reached" },
      { scope: "family", state: "reached" },
    ]);
  });

  it("carries no `reach` for a single-scope host — there is no fan-out to report on", async () => {
    let sawScopes = false;
    mount(undefined, {
      read: () => Promise.resolve({ open: [task("a")] }),
      readAll: () => {
        sawScopes = true;
        return Promise.resolve([]);
      },
    });
    const result = await readBoard({ limit: 500 });
    expect(result.reach).toBeUndefined();
    expect(sawScopes).toBe(false);
  });

  it("rejects when the own scope itself fails to answer", async () => {
    mount(
      [
        { id: "own", label: "Tasks", canWrite: true },
        { id: "family", label: "Family", canWrite: true },
      ],
      {
        readAll: () =>
          Promise.resolve([
            { scope: "own", ok: false, error: { message: "vault offline" } },
            { scope: "family", ok: true, data: { open: [task("f1")] } },
          ]),
      }
    );
    await expect(readBoard({ limit: 500 })).rejects.toThrow("vault offline");
  });
});
