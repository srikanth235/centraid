import { describe, expect, onTestFinished, test, vi } from "vitest";

import type { ReplicaReadWireResult } from "@centraid/client/replica/native";
import { useFakeClock } from "@centraid/test-kit/fake-clock";

import type { MobileReplicaSession } from "../../lib/replica/native-session";
import "../../test/upload-queue-absent";

vi.mock(
  import("react-native"),
  () =>
    ({
      AppState: {
        addEventListener: () => ({ remove: () => undefined }),
        currentState: "background",
      },
    }) as never
);

vi.mock(
  import("expo-media-library"),
  () =>
    ({
      getPermissionsAsync: () => Promise.resolve({ status: "denied" }),
      requestPermissionsAsync: () => Promise.resolve({ status: "denied" }),
    }) as never
);

vi.mock(
  import("../../lib/gateway"),
  () => ({ authHeader: () => ({}) }) as never
);

vi.mock(
  import("../../lib/replica/thumbnail-pack"),
  () => ({ pinnedThumbnailUri: () => undefined }) as never
);

vi.mock(
  import("./device-media"),
  () =>
    ({
      capturedAtIso: () => new Date(0).toISOString(),
      durationSeconds: () => undefined,
    }) as never
);

const { photoTimelineEngine } = await import("./timeline-engine");

const REPLICA_WINDOW_MS = 120;

const EMPTY_RESULT: ReplicaReadWireResult = {
  rows: [],
  cursor: { epoch: "mounted", seq: 1 },
  dependency: { shapeId: "photos-default", entity: "media.asset" },
  coverage: "complete",
};

interface Harness {
  session: MobileReplicaSession;
  passes: () => number;
  invalidate: () => void;
  settle: () => Promise<void>;
}

function harness(): Harness {
  let passes = 0;
  let invalidate = (): void => undefined;
  let waiting: Array<() => void> = [];
  const session = {
    read: (_appId: string, request: { entity: string }) => {
      if (request.entity === "media.asset") passes += 1;
      return new Promise<ReplicaReadWireResult>((resolve) => {
        waiting.push(() => resolve(EMPTY_RESULT));
      });
    },
    subscribe: (_appId: string, listener: () => void) => {
      invalidate = listener;
      return () => undefined;
    },
  } as unknown as MobileReplicaSession;
  const drain = async (rounds: number): Promise<void> => {
    if (rounds === 0) return;
    const pending = waiting;
    waiting = [];
    for (const resolve of pending) resolve();
    await Promise.resolve();
    await Promise.resolve();
    return drain(rounds - 1);
  };
  onTestFinished(photoTimelineEngine.acquire());
  return {
    session,
    passes: () => passes,
    invalidate: () => invalidate(),
    settle: () => drain(4),
  };
}

describe("photo timeline engine replica reads", () => {
  test("a burst of invalidations costs one follow-up pass", async () => {
    const clock = useFakeClock();
    const { session, passes, invalidate, settle } = harness();
    photoTimelineEngine.setSession(session, undefined);
    expect(passes()).toBe(1);

    for (let signal = 0; signal < 160; signal += 1) invalidate();
    await clock.advance(REPLICA_WINDOW_MS);
    expect(passes()).toBe(1);

    await settle();
    expect(passes()).toBe(2);
  });

  test("an invalidation during a pass produces exactly one follow-up", async () => {
    const clock = useFakeClock();
    const { session, passes, invalidate, settle } = harness();
    photoTimelineEngine.setSession(session, undefined);

    invalidate();
    await clock.advance(REPLICA_WINDOW_MS);
    await settle();
    expect(passes()).toBe(2);

    await clock.advance(10 * REPLICA_WINDOW_MS);
    await settle();
    expect(passes()).toBe(2);
  });

  test("invalidations arriving while idle still coalesce into one pass", async () => {
    const clock = useFakeClock();
    const { session, passes, invalidate, settle } = harness();
    photoTimelineEngine.setSession(session, undefined);
    await settle();
    expect(passes()).toBe(1);

    for (let signal = 0; signal < 12; signal += 1) invalidate();
    await clock.advance(REPLICA_WINDOW_MS);
    await settle();
    expect(passes()).toBe(2);
  });
});
