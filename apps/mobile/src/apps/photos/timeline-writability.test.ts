// A ROW'S WRITABILITY IS THE SESSION'S ANSWER, AND AN ABSENT ANSWER IS NOT A
// REFUSAL (#1011).
//
// `kit/replica/row-provenance.ts` states the invariant for every app on the
// phone: an unstamped row is writable, because a missing stamp is not a
// refusal. The Photos timeline used to contradict it twice — a camera-roll row
// carried no `canWrite` at all, and a replica row read a not-yet-known scope as
// `false` — so the owner's own vault rendered every lightbox with the
// read-only sentence under it.
import { describe, expect, onTestFinished, test, vi } from "vitest";

import type { Page } from "@centraid/core/page";

import type { MobileReplicaSession } from "../../lib/replica/native-session";
import type { NativeSeatPagePort } from "../../lib/replica/seat-port";
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

// Two photographs in the camera roll and nothing in this phone's copy of the
// vault: exactly the state a freshly paired owner's phone is in.
vi.mock(
  import("expo-media-library"),
  () =>
    ({
      getPermissionsAsync: () => Promise.resolve({ status: "granted" }),
      requestPermissionsAsync: () => Promise.resolve({ status: "granted" }),
      AssetField: { MEDIA_TYPE: "mediaType", CREATION_TIME: "creationTime" },
      MediaType: { IMAGE: "photo", VIDEO: "video" },
      Query: class {
        within(): this {
          return this;
        }
        orderBy(): this {
          return this;
        }
        limit(): this {
          return this;
        }
        offset(value: number): this {
          this.at = value;
          return this;
        }
        at = 0;
        exeForMetadata(): Promise<unknown[]> {
          return Promise.resolve(
            this.at > 0
              ? []
              : [
                  { id: "ph://one", mediaType: "photo", isFavorite: false },
                  { id: "ph://two", mediaType: "photo", isFavorite: false },
                ]
          );
        }
      },
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

const seat: NativeSeatPagePort = {
  page: (() => Promise.resolve({ rows: [] } as Page<object>)) as never,
  search: () => Promise.reject(new Error("not this test's question")),
};

function sessionWithScope(
  scope: (() => { vaultId: string; label: string; canWrite: boolean }) | null
): MobileReplicaSession {
  return {
    subscribe: () => () => undefined,
    ...(scope ? { scope } : {}),
  } as unknown as MobileReplicaSession;
}

async function settledAssets(
  session: MobileReplicaSession
): Promise<readonly { canWrite?: boolean }[]> {
  onTestFinished(photoTimelineEngine.acquire());
  photoTimelineEngine.setSession(session, "http://gateway.test", seat);
  // The walk resolves through a chain of microtasks; draining a fixed number
  // of them is what "settled" means for a fixture with no real I/O in it.
  await Array.from({ length: 12 }).reduce<Promise<void>>(
    (chain) => chain.then(() => undefined),
    Promise.resolve()
  );
  return photoTimelineEngine.getSnapshot().assets;
}

describe("the timeline's writability answer", () => {
  test("a camera-roll row on the owner's own vault is writable", async () => {
    const assets = await settledAssets(
      sessionWithScope(() => ({
        vaultId: "vault-1",
        label: "Personal",
        canWrite: true,
      }))
    );
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.every((asset) => asset.canWrite === true)).toBe(true);
  });

  test("a session that has not said yet is not a refusal", async () => {
    const assets = await settledAssets(sessionWithScope(null));
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.every((asset) => asset.canWrite === true)).toBe(true);
  });

  test("a vault that says no is still honoured", async () => {
    const assets = await settledAssets(
      sessionWithScope(() => ({
        vaultId: "vault-1",
        label: "Shared",
        canWrite: false,
      }))
    );
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.every((asset) => asset.canWrite === false)).toBe(true);
  });
});
