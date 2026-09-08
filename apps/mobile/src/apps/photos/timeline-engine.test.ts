// Bootstrap × timeline read amplification (#880).
//
// The engine subscribes to "photos" invalidations. The bootstrap emits one per
// committed page, so a 50,000-row cold start delivers this listener hundreds of
// signals. Each pass walks the whole library over the seat's file — the file
// the bootstrap is writing — so an unguarded listener stacked dozens of them
// concurrently.
//
// What these tests pin: a burst costs one pass, and a signal that lands
// mid-pass costs exactly one follow-up — never a pass per signal. Since #996
// W5-D1 a pass is ONE joined statement over the seat rather than seven
// whole-table reads through the declarative plane, and the coalescing claim is
// unchanged by that — which is what makes it worth keeping pinned here.
import { describe, expect, onTestFinished, test, vi } from "vitest";

import type { Page, PageQuery } from "@centraid/core/page";
import { useFakeClock } from "@centraid/test-kit/fake-clock";

import type { MobileReplicaSession } from "../../lib/replica/native-session";
import type { NativeSeatPagePort } from "../../lib/replica/seat-port";
// Registers the frame's no-upload-queue stand-in; the subject is imported
// dynamically below so this runs first.
import "../../test/upload-queue-absent";

vi.mock(
  import("react-native"),
  () =>
    ({
      AppState: {
        addEventListener: () => ({ remove: () => undefined }),
        // Never "active": the upload poll is another surface's concern.
        currentState: "background",
      },
    }) as never
);

// No camera roll in this fixture: the device walk stops at the permission.
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

/** The engine's own invalidation window; the test fails if it is retuned. */
const REPLICA_WINDOW_MS = 120;

interface Harness {
  session: MobileReplicaSession;
  seat: NativeSeatPagePort;
  /** A pass is one library walk; this counts passes, not pages. */
  passes: () => number;
  invalidate: () => void;
  settle: () => Promise<void>;
}

/**
 * A mounted engine with a session whose reads only resolve when the test says
 * so — the window where a real bootstrap's invalidations land.
 */
function harness(): Harness {
  let passes = 0;
  let invalidate = (): void => undefined;
  let waiting: Array<() => void> = [];
  const session = {
    subscribe: (_appId: string, listener: () => void) => {
      invalidate = listener;
      return () => undefined;
    },
    scope: () => undefined,
  } as unknown as MobileReplicaSession;
  const seat: NativeSeatPagePort = {
    page: (<Row extends object>(request: { query: PageQuery<Row> }) => {
      // A PASS IS COUNTED WHERE IT BEGINS. The walk's first statement is the
      // starred-concept lookup, and it is asked synchronously inside the pass —
      // so counting it is counting passes, which is what these tests are about.
      // Counting the library pages instead would count PAGES, and a library
      // that grew a page would look like a coalescing regression.
      if (request.query.name === "photos.library.starred-concept") passes += 1;
      return new Promise<Page<Row>>((resolve) => {
        waiting.push(() => resolve({ rows: [] }));
      });
    }) as NativeSeatPagePort["page"],
    search: () => Promise.reject(new Error("not this test's question")),
  };
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
    seat,
    passes: () => passes,
    invalidate: () => invalidate(),
    // Answer whatever is outstanding, then let a follow-up pass start and
    // register its own reads before answering those too.
    settle: () => drain(4),
  };
}

describe("photo timeline engine replica reads", () => {
  test("a burst of invalidations costs one follow-up pass", async () => {
    // The clock is installed here, before `acquire`'s release is registered,
    // so engine teardown runs while fake timers are still in place.
    const clock = useFakeClock();
    const { session, seat, passes, invalidate, settle } = harness();
    photoTimelineEngine.setSession(session, undefined, seat);
    expect(passes()).toBe(1);

    // A 50k bootstrap: ~40 pages × 4 mounted scopes.
    for (let signal = 0; signal < 160; signal += 1) invalidate();
    await clock.advance(REPLICA_WINDOW_MS);
    // Still the one in-flight pass: the burst collapsed into a single run, and
    // that run found a pass already going.
    expect(passes()).toBe(1);

    await settle();
    expect(passes()).toBe(2);
  });

  test("an invalidation during a pass produces exactly one follow-up", async () => {
    // The clock is installed here, before `acquire`'s release is registered,
    // so engine teardown runs while fake timers are still in place.
    const clock = useFakeClock();
    const { session, seat, passes, invalidate, settle } = harness();
    photoTimelineEngine.setSession(session, undefined, seat);

    invalidate();
    await clock.advance(REPLICA_WINDOW_MS);
    await settle();
    expect(passes()).toBe(2);

    // Nothing arrived after that follow-up, so nothing else runs.
    await clock.advance(10 * REPLICA_WINDOW_MS);
    await settle();
    expect(passes()).toBe(2);
  });

  test("invalidations arriving while idle still coalesce into one pass", async () => {
    // The clock is installed here, before `acquire`'s release is registered,
    // so engine teardown runs while fake timers are still in place.
    const clock = useFakeClock();
    const { session, seat, passes, invalidate, settle } = harness();
    photoTimelineEngine.setSession(session, undefined, seat);
    await settle();
    expect(passes()).toBe(1);

    for (let signal = 0; signal < 12; signal += 1) invalidate();
    await clock.advance(REPLICA_WINDOW_MS);
    await settle();
    expect(passes()).toBe(2);
  });
});
