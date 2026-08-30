import { describe, expect, it, vi } from "vitest";

import { onDataChange } from "@centraid/design/elements";

import type * as TypeImport_oycips from "../../gateway-client-core.js";
import type { ReplicaInvalidation } from "../../replica/types.js";
import { installInlineCentraid } from "./centraid-inline.js";

// The seam between the element layer's refresh discipline and the shell: apps
// call `onDataChange`, which reads `window.centraid.onChange` — installed HERE.
// Neither side can prove the contract alone, so this suite drives the real
// pair: a replica invalidation in, a debounced app callback out.
//
// gateway-client-core touches window.CentraidApi at module load; stub the whole
// module (this suite exercises no gateway I/O). Vitest hoists the mock above
// the imports at run time.
const readJson = vi.fn<(res: Response, op: string) => Promise<unknown>>();
type InlineSession = NonNullable<
  Parameters<typeof installInlineCentraid>[0]["session"]
>;

vi.mock(import("../../gateway-client-core.js") as Promise<unknown>, () => ({
  auth: vi.fn<typeof TypeImport_oycips.auth>(async () => ({
    baseUrl: "https://gw.test",
    token: "tok",
  })),
  authHeaders: () => ({}),
  doFetch: vi.fn<typeof TypeImport_oycips.doFetch>(),
  readJson: <T>(...args: Parameters<typeof readJson>) =>
    readJson(...args) as Promise<T>,
  VAULT_HEADER: "x-centraid-vault",
}));

function fakeSession(
  subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void>
) {
  return {
    read: vi.fn<InlineSession["read"]>(),
    search: vi.fn<InlineSession["search"]>(),
    write: vi.fn<InlineSession["write"]>(),
    subscribe: vi.fn<InlineSession["subscribe"]>((_appId, _deps, listener) => {
      subscribers.push(listener);
      return () => undefined;
    }),
  } satisfies InlineSession;
}

describe("inline change feed", () => {
  it("onDataChange subscribes through the inline replica session and fires on invalidation", async () => {
    const subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void> =
      [];
    installInlineCentraid({
      appId: "tasks",
      session: fakeSession(subscribers),
      queries: {},
    });
    try {
      const seen: Array<{ tables?: string[] }> = [];
      const stop = onDataChange(
        ["schedule.task"],
        (detail) => seen.push(detail),
        {
          debounceMs: 0,
        }
      );
      expect(subscribers).toHaveLength(1);

      subscribers[0]?.([
        {
          shapeId: "s",
          entity: "schedule.task",
          source: "canonical",
        } as ReplicaInvalidation,
      ]);
      // `onDataChange` debounces on a timer even at 0ms, so the callback lands
      // a macrotask later — poll the outcome rather than sleeping past it.
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]?.tables).toStrictEqual(["schedule.task"]);
      stop();
    } finally {
      delete (window as { centraid?: unknown }).centraid;
    }
  });

  it("a change naming tables this app does not read causes NO invalidation", async () => {
    const subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void> =
      [];
    installInlineCentraid({
      appId: "tasks",
      session: fakeSession(subscribers),
      queries: {},
    });
    try {
      const seen: Array<{ tables?: string[] }> = [];
      const stop = onDataChange(
        ["schedule.task"],
        (detail) => seen.push(detail),
        { debounceMs: 0 }
      );

      subscribers[0]?.([
        { shapeId: "s", entity: "media.asset", source: "canonical" },
        { shapeId: "s", entity: "finance.expense", source: "canonical" },
      ] as ReplicaInvalidation[]);
      // Then one it DOES read, so the assertion cannot pass vacuously.
      subscribers[0]?.([
        { shapeId: "s", entity: "schedule.task", source: "canonical" },
      ] as ReplicaInvalidation[]);

      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]?.tables).toStrictEqual(["schedule.task"]);
      stop();
    } finally {
      delete (window as { centraid?: unknown }).centraid;
    }
  });

  // The empty list is the WILDCARD channel, not a coarse fallback: the
  // coordinator emits `entity: "*"` for bootstrap, commit, purge and scope
  // teardown, none of them a table and all of them every app's business.
  it("a wildcard invalidation reaches an app whose declared tables it does not name", async () => {
    const subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void> =
      [];
    installInlineCentraid({
      appId: "tasks",
      session: fakeSession(subscribers),
      queries: {},
    });
    try {
      const seen: Array<{ tables?: string[] }> = [];
      const stop = onDataChange(
        ["schedule.task"],
        (detail) => seen.push(detail),
        { debounceMs: 0 }
      );

      subscribers[0]?.([
        { shapeId: "*", entity: "*", source: "purge" },
      ] as ReplicaInvalidation[]);

      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]?.tables).toStrictEqual([]);
      stop();
    } finally {
      delete (window as { centraid?: unknown }).centraid;
    }
  });
});
