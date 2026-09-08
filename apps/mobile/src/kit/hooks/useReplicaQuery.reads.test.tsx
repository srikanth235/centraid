// @vitest-environment jsdom
/**
 * ONE WRITE, ONE RE-READ — COUNTED, ON THE SEAT THAT PAYS FOR IT (#922 C4/E3).
 *
 * A screen holds one read per entity it draws from: Agenda holds eleven, Photos
 * six, People seven. The mounted session reports every invalidation the whole
 * APP produced, so before this every one of those reads re-ran on every change
 * — eleven reads for one edited event, and eleven more for the next
 * invalidation in the same batch. This suite is the counter: it mounts each
 * app's real read set, fires the invalidation ONE write on that app produces,
 * and asserts the number of reads that follow.
 *
 * The numbers it holds are the eight in the receipt. They are read counts, not
 * milliseconds, so they mean the same thing on any host.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReplicaInvalidation } from "@centraid/client/replica/native";
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
vi.mock(
  import("react-native-svg"),
  async () =>
    (await hosts()).svgStub() as unknown as typeof import("react-native-svg")
);
vi.mock(import("react-native-safe-area-context"), () => ({
  useSafeAreaInsets: () => ({ bottom: 34, left: 0, right: 0, top: 47 }),
}));

const reads: string[] = [];
let listeners: Array<(invalidations: readonly ReplicaInvalidation[]) => void> =
  [];

const REPLICA = {
  ready: true,
  reachability: "current" as const,
  scopes: [],
  session: {
    read: (_appId: string, request: { entity: string }) => {
      reads.push(request.entity);
      return Promise.resolve({
        rows: [],
        cursor: { epoch: "e", seq: 1 },
        dependency: { shapeId: "s", entity: request.entity },
      });
    },
    subscribe: (
      _appId: string,
      listener: (invalidations: readonly ReplicaInvalidation[]) => void
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

const {
  useReplicaQuery,
  mapReplicaRows,
  readDependsOn,
  replicaFieldUnavailable,
} = await import("./useReplicaQuery");

/**
 * The read set each app's home screen holds, taken from its own read layer
 * (`useAgenda`, `usePeople`, `useDocs`, …). A new entity on a screen belongs
 * here, which is what keeps this a census rather than a sample.
 */
const APP_READS: Record<string, { entities: string[]; write: string }> = {
  agenda: {
    entities: [
      "core.event",
      "schedule.attendee",
      "schedule.event_ext",
      "core.party",
      "schedule.calendar",
      "schedule.recurrence_exception",
      "core.vault",
      "schedule.task",
      "core.tag",
      "core.concept",
      "core.concept_scheme",
    ],
    write: "core.event",
  },
  docs: {
    entities: [
      "core.document",
      "core.content_item",
      "core.concept",
      "core.tag",
    ],
    write: "core.document",
  },
  locker: {
    entities: ["locker.item", "core.concept"],
    write: "locker.item",
  },
  notes: {
    entities: [
      "knowledge.note",
      "core.content_item",
      "core.collection",
      "core.collection_entry",
      "core.concept",
      "core.tag",
    ],
    write: "knowledge.note",
  },
  people: {
    entities: [
      "people.profile",
      "core.party",
      "core.tag",
      "core.concept",
      "core.concept_scheme",
      "people.important_date",
    ],
    write: "people.profile",
  },
  photos: {
    entities: [
      "media.asset",
      "core.collection",
      "core.collection_entry",
      "core.place",
      "media.face_region",
      "core.party",
    ],
    write: "media.asset",
  },
  tally: {
    entities: ["tally.expense", "tally.group", "core.party", "tally.friend"],
    write: "tally.expense",
  },
  tasks: {
    entities: ["schedule.task", "schedule.project", "schedule.section"],
    write: "schedule.task",
  },
};

function Screen(props: {
  appId: string;
  entities: string[];
}): React.JSX.Element {
  return (
    <>
      {props.entities.map((entity) => (
        <Read appId={props.appId} entity={entity} key={entity} />
      ))}
    </>
  );
}

function Read(props: { appId: string; entity: string }): React.JSX.Element {
  // Exactly the shape every screen's own `useMemo` produces: one stable request
  // object per entity, so the hook's effect keys on identity as it does live.
  const request = React.useMemo(
    () => ({ acceptTruncation: true, entity: props.entity }),
    [props.entity]
  );
  const state = useReplicaQuery(props.appId, request as never);
  return <span data-testid={props.entity}>{state.rows.length}</span>;
}

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function settle(): Promise<void> {
  // Three macrotask turns for the read and React's commit, then past the
  // hook's 120 ms invalidation-coalescing window.
  await forEachSequentially([0, 0, 0, 160], (ms) => tick(ms));
}

function invalidate(
  entity: string,
  source: ReplicaInvalidation["source"]
): void {
  const invalidations: ReplicaInvalidation[] = [
    { entity, shapeId: "s", source },
  ];
  // A copy: a listener that unsubscribes mid-batch must not shorten the batch.
  const batch = listeners.slice();
  for (const listener of batch) listener(invalidations);
}

describe("one write, one re-read", () => {
  afterEach(() => {
    reads.length = 0;
    listeners = [];
  });

  it.each(Object.entries(APP_READS))(
    "%s: one write on the app re-reads one screen read",
    async (appId, { entities, write }) => {
      const { unmount } = mountBlock(
        <Screen appId={appId} entities={entities} />
      );
      await settle();
      expect(reads).toHaveLength(entities.length);
      reads.length = 0;

      // The seat's own optimistic write: one overlay invalidation, on the one
      // entity the projection touched.
      invalidate(write, "overlay");
      await settle();
      expect(reads).toStrictEqual([write]);
      unmount();
    }
  );

  it("a purge re-reads everything, because it removes the plane", async () => {
    const { entities } = APP_READS["agenda"]!;
    const { unmount } = mountBlock(
      <Screen appId="agenda" entities={entities} />
    );
    await settle();
    reads.length = 0;
    invalidate("core.event", "purge");
    await settle();
    expect(reads).toHaveLength(entities.length);
    unmount();
  });

  it("a change to one entity does not reparse the rest of the library", async () => {
    // Photos: a place rename must not re-read the asset library (#922 E3).
    const { entities } = APP_READS["photos"]!;
    const { unmount } = mountBlock(
      <Screen appId="photos" entities={entities} />
    );
    await settle();
    reads.length = 0;
    invalidate("core.place", "canonical");
    await settle();
    expect(reads).toStrictEqual(["core.place"]);
    unmount();
  });

  it("a bootstrap burst costs one re-read per CHANGED entity, not per read", async () => {
    // Agenda's first paint is the worst case on the phone: eleven reads on one
    // screen, and a bootstrap that lands one invalidation batch per entity.
    // Before the filter every batch re-ran all eleven; now each re-runs one.
    const { entities } = APP_READS["agenda"]!;
    const { unmount } = mountBlock(
      <Screen appId="agenda" entities={entities} />
    );
    await settle();
    expect(reads).toHaveLength(entities.length);
    reads.length = 0;
    await forEachSequentially(entities, async (entity) => {
      invalidate(entity, "canonical");
      await settle();
    });
    // One per batch: eleven, not eleven times eleven.
    expect(reads).toStrictEqual(entities);
    unmount();
  });

  it("counts the reads a whole app screen costs per invalidation batch", () => {
    // The predicate under the counter, stated once without a renderer.
    const request = { acceptTruncation: true, entity: "core.event" } as never;
    expect(
      readDependsOn(request, [
        { entity: "core.party", shapeId: "s", source: "canonical" },
      ])
    ).toBe(false);
    expect(
      readDependsOn(request, [
        { entity: "core.event", shapeId: "s", source: "overlay" },
      ])
    ).toBe(true);
    expect(
      readDependsOn(request, [
        { entity: "core.party", shapeId: "s", source: "purge" },
      ])
    ).toBe(true);
  });
});

describe("a lazily-loaded column is absent, not empty", () => {
  it("carries the envelope's oversized fields onto the mapped row", () => {
    const [row] = mapReplicaRows({
      rows: [
        {
          rowId: "note-1",
          values: { note_id: "note-1", title: "Lease" },
          oversizedFields: ["body_text"],
          hasUnavailableFields: false,
        },
      ],
      cursor: { epoch: "e", seq: 1 },
      dependency: { shapeId: "s", entity: "knowledge.note" },
    });
    expect(replicaFieldUnavailable(row, "body_text")).toContain("body_text");
    expect(replicaFieldUnavailable(row, "title")).toBeUndefined();
  });

  it("says nothing about a row that holds everything", () => {
    const [row] = mapReplicaRows({
      rows: [
        {
          rowId: "note-2",
          values: { note_id: "note-2", body_text: "All here" },
          oversizedFields: [],
          hasUnavailableFields: false,
        },
      ],
      cursor: { epoch: "e", seq: 1 },
      dependency: { shapeId: "s", entity: "knowledge.note" },
    });
    expect(replicaFieldUnavailable(row, "body_text")).toBeUndefined();
    expect("__oversizedFields" in row!).toBe(false);
  });
});
