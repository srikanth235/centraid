/**
 * The 50k-row reconnect corpus and its gateway pages, shared by the two tests
 * that grew out of one probe: the CLIENT-SIDE TIMING, which gates on a
 * wall-clock ceiling and therefore lives in the isolated nightly scale lane
 * (`tests/scale/mobile-reconnect-to-fresh.scale.test.ts`), and the untimed D1
 * correctness test beside this file, which belongs in the ordinary suite.
 */
import type {
  ReplicaChangeBatch,
  ReplicaSnapshotRow,
} from "@centraid/client/replica/native";

import type { AppStateLike } from "./native-session";

/** Year-3 replica rows on a phone (tests/journeys.json `volumes.year3-replica`). */
export const REPLICA_ROWS = 50_000;
/** Changes committed while the phone was away. */
export const MISSED_CHANGES = 200;
/** The page a Photos/Docs screen asks for. */
export const SCREEN_PAGE = 200;
/** Watchdog: a hang FAILS rather than hangs. */
export const RESUME_DEADLINE_MS = 120_000;

export const SHAPE_ID = "shape-library";
export const ENTITY = "core.content_item";
export const APP_ID = "photos";

/** Clock-free: the same rows on every host. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function contentId(index: number): string {
  return `content-${index.toString().padStart(6, "0")}`;
}

export function corpus(): ReplicaSnapshotRow[] {
  const random = seededRandom(883_002);
  return Array.from({ length: REPLICA_ROWS }, (_unused, index) => {
    const capturedMs =
      Date.UTC(2023, 0, 1) + Math.floor(random() * 3 * 365 * 86_400_000);
    return {
      shapeId: SHAPE_ID,
      entity: ENTITY,
      rowId: contentId(index),
      values: {
        content_id: contentId(index),
        title: `Item ${index}`,
        deleted_at: null,
        created_at: new Date(capturedMs).toISOString(),
      },
    } satisfies ReplicaSnapshotRow;
  });
}

export function bootstrapPage(
  rows: ReplicaSnapshotRow[]
): Record<string, unknown> {
  return {
    protocolVersion: 1,
    vaultId: "vault-a",
    schemaEpoch: "schema-1",
    cursor: { epoch: "replica-1", seq: 1 },
    rows,
    complete: true,
    shapeIds: [SHAPE_ID],
    shapes: [
      {
        shapeId: SHAPE_ID,
        appId: APP_ID,
        entities: [
          {
            entity: ENTITY,
            primaryKey: "content_id",
            columns: ["content_id", "title", "deleted_at", "created_at"],
          },
        ],
      },
    ],
  };
}

export function missedBatch(): ReplicaChangeBatch {
  return {
    protocolVersion: 1,
    schemaEpoch: "schema-1",
    from: { epoch: "replica-1", seq: 1 },
    to: { epoch: "replica-1", seq: 2 },
    changes: Array.from({ length: MISSED_CHANGES }, (_unused, index) => ({
      op: "upsert" as const,
      shapeId: SHAPE_ID,
      entity: ENTITY,
      rowId: contentId(index),
      values: {
        content_id: contentId(index),
        title: `Renamed while away ${index}`,
        deleted_at: null,
        // Dated past every seeded row, so a newest-first page must carry them.
        created_at: new Date(Date.UTC(2027, 0, 1) + index * 1000).toISOString(),
      },
    })),
  };
}

export function createAppState(): AppStateLike & {
  send: (state: string) => void;
} {
  let handler: ((state: string) => void) | undefined;
  let currentState = "active";
  return {
    get currentState() {
      return currentState;
    },
    addEventListener(_type, next) {
      handler = next;
      return {
        remove: () => {
          handler = undefined;
        },
      };
    },
    send(state) {
      currentState = state;
      handler?.(state);
    },
  };
}
