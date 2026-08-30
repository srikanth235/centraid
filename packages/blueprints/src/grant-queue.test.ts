/*
 * THE OFFLINE GRANT QUEUE (#883), at the transport where it lives.
 *
 * Three claims, and they are the whole of the ruled design: a grant taken off
 * the network is HELD rather than lost, the held intents execute against the
 * grant ROUTES in order once the gateway answers, and a refusal on execution
 * leaves the queue carrying the route's OWN WORDS rather than being retried
 * forever. The seat-shaped halves — IndexedDB on the browser, AsyncStorage on
 * the phone — are tested where they live; this is the law both share.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

const moduleUrl = (file: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/_shared", file))
    .href;

const { GrantUnreachableError, isQueuedGrantAnswer, queuedGrantWireCalls } =
  (await import(
    moduleUrl("grant-transport.ts")
  )) as typeof import("../apps/_shared/grant-transport.ts");
const { grantDoor } = (await import(
  moduleUrl("grant-door.ts")
)) as typeof import("../apps/_shared/grant-door.ts");
const { GRANT_QUEUED, REVOKE_QUEUED } = (await import(
  moduleUrl("grant-copy.ts")
)) as typeof import("../apps/_shared/grant-copy.ts");

type Intent = import("../apps/_shared/grant-transport.ts").QueuedGrantIntent;

/** A store with the ONE property the ruling asks of a seat's: it survives. */
function memoryQueue(kept: Intent[] = []) {
  return {
    kept,
    list: () => Promise.resolve([...kept]),
    append: (intent: Intent) => {
      kept.push(intent);
      return Promise.resolve();
    },
    remove: (intentId: string) => {
      const at = kept.findIndex((intent) => intent.intentId === intentId);
      if (at >= 0) kept.splice(at, 1);
      return Promise.resolve();
    },
  };
}

const REQUEST = {
  audienceKind: "party",
  audienceId: "p1",
  subjectType: "core.document",
  subjectId: "d1",
  capability: "view",
} as const;

function wire(behaviour: {
  create?: () => Promise<unknown>;
  revoke?: () => Promise<unknown>;
}) {
  const calls: string[] = [];
  return {
    calls,
    wire: {
      subjects: () => Promise.resolve({ subjects: [] }),
      forParty: () => Promise.resolve(undefined),
      forAudience: () => Promise.resolve(undefined),
      forSubject: () => Promise.resolve({ grants: [] }),
      create: () => {
        calls.push("create");
        return behaviour.create?.() ?? Promise.resolve({ outcome: "created" });
      },
      revoke: () => {
        calls.push("revoke");
        return behaviour.revoke?.() ?? Promise.resolve({ outcome: "revoked" });
      },
    },
  };
}

const unreachable = () =>
  Promise.reject(new GrantUnreachableError("share")) as Promise<unknown>;

describe("the offline grant queue", () => {
  let ids = 0;
  const options = {
    newIntentId: () => `i${++ids}`,
    now: () => "2026-08-28T00:00:00.000Z",
  };
  beforeEach(() => {
    ids = 0;
  });

  it("holds a grant the gateway could not be reached for", async () => {
    const store = memoryQueue();
    const { wire: calls } = wire({ create: unreachable });
    const queued = queuedGrantWireCalls(calls, store, options);

    const answer = await queued.create(REQUEST);
    expect(isQueuedGrantAnswer(answer)).toBe(true);
    expect(store.kept).toStrictEqual([
      {
        intentId: "i1",
        queuedAt: "2026-08-28T00:00:00.000Z",
        op: "create",
        request: REQUEST,
      },
    ]);
  });

  it("the sheet reads it in the wire's own word, not as a refusal", async () => {
    const store = memoryQueue();
    const door = grantDoor(
      queuedGrantWireCalls(wire({ create: unreachable }).wire, store, options)
    );
    const outcome = await door.create({ ...REQUEST });
    expect(outcome).toStrictEqual({
      ok: true,
      outcome: "queued",
      message: GRANT_QUEUED,
    });
    expect(GRANT_QUEUED.startsWith("On its way")).toBe(true);

    const revoked = await grantDoor(
      queuedGrantWireCalls(wire({ revoke: unreachable }).wire, store, options)
    ).revoke("g1");
    expect(revoked).toStrictEqual({
      ok: true,
      queued: true,
      message: REVOKE_QUEUED,
    });
    // No promise rides with a withdrawal the vault has not been asked for yet.
    expect("promise" in revoked).toBe(false);
  });

  it("never overtakes: a backlog goes out in front of the new intent", async () => {
    const store = memoryQueue();
    let offline = true;
    const { wire: calls, calls: sent } = wire({
      create: () => (offline ? unreachable() : Promise.resolve({})),
      revoke: () => (offline ? unreachable() : Promise.resolve({})),
    });
    const queued = queuedGrantWireCalls(calls, store, options);

    await queued.revoke("g1");
    expect(store.kept.map((intent) => intent.op)).toStrictEqual(["revoke"]);

    // Reachable again. The held withdrawal is sent FIRST — a grant that landed
    // before the withdrawal it replaces would be the answer edited in place
    // that ruling V-table refuses — and only then does the new grant go.
    offline = false;
    await queued.create(REQUEST);
    expect(sent).toStrictEqual(["revoke", "revoke", "create"]);
    expect(store.kept).toStrictEqual([]);
  });

  it("holds the new intent behind a backlog that still cannot leave", async () => {
    const store = memoryQueue();
    const { wire: calls, calls: sent } = wire({
      create: unreachable,
      revoke: unreachable,
    });
    const queued = queuedGrantWireCalls(calls, store, options);

    await queued.revoke("g1");
    await queued.create(REQUEST);
    // The drain pass tried the withdrawal again and could not send it, so the
    // grant waits behind it rather than being attempted out of order.
    expect(sent).toStrictEqual(["revoke", "revoke"]);
    expect(store.kept.map((intent) => intent.op)).toStrictEqual([
      "revoke",
      "create",
    ]);
  });

  it("survives a relaunch: a fresh transport drains what the last one held", async () => {
    const durable: Intent[] = [];
    await queuedGrantWireCalls(
      wire({ create: unreachable }).wire,
      memoryQueue(durable),
      options
    ).create(REQUEST);
    expect(durable).toHaveLength(1);

    // A new process, a new transport, the same store.
    const { wire: calls, calls: sent } = wire({});
    const drain = await queuedGrantWireCalls(
      calls,
      memoryQueue(durable),
      options
    ).drain();
    expect(drain.sent).toBe(1);
    expect(sent).toStrictEqual(["create"]);
    expect(durable).toStrictEqual([]);
  });

  it("a refusal on execution leaves the queue in the route's own words", async () => {
    const durable: Intent[] = [];
    const store = memoryQueue(durable);
    await queuedGrantWireCalls(
      wire({ create: unreachable }).wire,
      store,
      options
    ).create(REQUEST);

    const refused = queuedGrantWireCalls(
      wire({
        create: () =>
          Promise.reject(
            new Error(
              "this is already shared for edit; withdraw that first — an answer changed in place could not be audited"
            )
          ),
      }).wire,
      store,
      options
    );
    const drain = await refused.drain();
    expect(drain.sent).toBe(0);
    expect(drain.refused).toHaveLength(1);
    expect(drain.refused[0]!.message).toBe(
      "this is already shared for edit; withdraw that first — an answer changed in place could not be audited"
    );
    // Answered is answered: it is not asked again on the next pass.
    expect(durable).toStrictEqual([]);
    expect((await refused.drain()).refused).toStrictEqual([]);
  });

  it("keeps its place when the gateway is still out of reach", async () => {
    const durable: Intent[] = [];
    const store = memoryQueue(durable);
    const offline = queuedGrantWireCalls(
      wire({ create: unreachable, revoke: unreachable }).wire,
      store,
      options
    );
    await offline.create(REQUEST);
    await offline.revoke("g1");
    const drain = await offline.drain();
    expect(drain).toStrictEqual({ sent: 0, refused: [], queued: 2 });
    expect(durable.map((intent) => intent.op)).toStrictEqual([
      "create",
      "revoke",
    ]);
    await expect(offline.pending()).resolves.toHaveLength(2);
  });

  it("never queues a READ — an unanswered read has no answer to hold", async () => {
    const store = memoryQueue();
    const queued = queuedGrantWireCalls(
      {
        ...wire({}).wire,
        subjects: () => unreachable(),
      },
      store,
      options
    );
    await expect(queued.subjects()).rejects.toThrow(/could not be reached/u);
    expect(store.kept).toStrictEqual([]);
  });
});
