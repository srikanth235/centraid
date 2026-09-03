// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import {
  decoratePendingMutation,
  pendingUpsert,
} from "../_shared/pending-overlay.ts";
import type {
  PendingIntentPresentationInput,
  PendingProjectionValue,
} from "../_shared/pending-overlay.ts";
import { assetKey } from "./asset-key.ts";
import { AlbumGridView } from "./components/AlbumGrid.tsx";
import { FaceReview } from "./components/FaceReview.tsx";
import { Tile } from "./components/Tile.tsx";
import type { Album, Asset } from "./types.ts";

const INTENT = "intent-photos-write";

const BASE_ASSET = {
  asset_id: "asset-harbour",
  content_id: "content-harbour",
  title: "harbour-at-dusk.jpg",
  kind: "photo",
  media_type: "image/jpeg",
  width: 1200,
  height: 800,
  captured_at: "2026-07-04T18:20:00.000Z",
  favorite: 1,
} satisfies Record<string, PendingProjectionValue>;

const BASE_ALBUM = {
  album_id: "alb-cornwall",
  title: "Cornwall 2024",
  count: 12,
} satisfies Record<string, PendingProjectionValue>;

function decorate(
  entity: string,
  rowId: string,
  values: Record<string, PendingProjectionValue>,
  intent: PendingIntentPresentationInput
): Record<string, PendingProjectionValue> {
  return decoratePendingMutation(pendingUpsert(entity, rowId, values), intent)
    .values;
}

function pendingAsset(intent: PendingIntentPresentationInput): Asset {
  return decorate(
    "media.asset",
    BASE_ASSET.asset_id,
    BASE_ASSET,
    intent
  ) as unknown as Asset;
}

function pendingAlbum(intent: PendingIntentPresentationInput): Album {
  return decorate(
    "core.collection",
    BASE_ALBUM.album_id,
    BASE_ALBUM,
    intent
  ) as unknown as Album;
}

const VIEWS = [
  [
    "timeline tile",
    (intent: PendingIntentPresentationInput, onEdit: (key: string) => void) => (
      <Tile
        asset={pendingAsset(intent)}
        width={200}
        height={150}
        rung={2}
        selected={false}
        selectMode={false}
        vaultMark={null}
        onOpen={onEdit}
        onToggleSelect={() => {}}
        onEnterSelectMode={() => {}}
      />
    ),
    assetKey({ asset_id: BASE_ASSET.asset_id }),
  ],
  [
    "album card",
    (intent: PendingIntentPresentationInput, onEdit: (key: string) => void) => (
      <AlbumGridView
        albums={[pendingAlbum(intent)]}
        onOpen={onEdit}
        onNewAlbum={() => {}}
      />
    ),
    BASE_ALBUM.album_id,
  ],
] as const;

describe("a Photos row whose write has not landed", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  async function paint(
    view: (typeof VIEWS)[number][1],
    intent: PendingIntentPresentationInput,
    onEdit: (key: string) => void = () => {}
  ): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(view(intent, onEdit)));
    const region = container.querySelector<HTMLElement>(
      '[aria-label^="Pending change:"]'
    );
    expect(region).not.toBeNull();
    return region!;
  }

  const buttonsIn = (region: HTMLElement): HTMLButtonElement[] => [
    ...region.querySelectorAll("button"),
  ];

  test.each(VIEWS)(
    "%s: a queued write says it is waiting for a connection",
    async (_name, view) => {
      (window as unknown as { centraid: unknown }).centraid = {};

      const region = await paint(view, {
        intentId: INTENT,
        state: "queued",
        action: "favorite",
      });

      expect(region.querySelector(".kit-pending-chip")?.textContent).toBe(
        "queued"
      );
      expect(
        region.querySelector(".kit-pending-chip")?.getAttribute("title")
      ).toBe("Waiting for a connection.");
      expect(region.getAttribute("aria-label")).toBe(
        "Pending change: Waiting for a connection."
      );
      expect(
        buttonsIn(region).map((button) => button.textContent)
      ).toStrictEqual([]);
    }
  );

  test.each(VIEWS)(
    "%s: a parked write says who is waiting and offers the Approvals inbox",
    async (_name, view) => {
      const opened: string[] = [];
      (window as unknown as { centraid: unknown }).centraid = {
        openApprovals: () => opened.push("approvals"),
      };

      const region = await paint(view, {
        intentId: INTENT,
        state: "parked",
        action: "favorite",
      });

      expect(region.querySelector(".kit-pending-chip")?.textContent).toBe(
        "parked"
      );
      expect(region.textContent).toContain(
        "Waiting for the owner to approve this change."
      );
      const review = buttonsIn(region).find(
        (button) => button.textContent === "Review in Approvals"
      );
      expect(review).toBeDefined();
      await act(async () => review?.click());
      expect(opened).toStrictEqual(["approvals"]);
    }
  );

  test.each(VIEWS)(
    "%s: a conflict prints both versions and offers edit, retry and discard",
    async (_name, view, editToken) => {
      const settled: string[] = [];
      const edited: string[] = [];
      const settle =
        (verb: string) => (key: string, scopeId: string | undefined) => {
          settled.push(`${verb} ${key} @ ${scopeId ?? "self"}`);
          return Promise.resolve(true);
        };
      (window as unknown as { centraid: unknown }).centraid = {
        retryPendingWrite: settle("retry"),
        discardPendingWrite: settle("discard"),
      };

      const region = await paint(
        view,
        {
          intentId: INTENT,
          state: "conflict",
          action: "favorite",
          conflict: { expectedVersion: 4, actualVersion: 5 },
        },
        (key) => edited.push(key)
      );

      expect(region.querySelector(".kit-pending-chip")?.textContent).toBe(
        "conflict"
      );
      expect(region.textContent).toContain(
        "This row changed somewhere else. Expected version 4; found 5."
      );
      const buttons = buttonsIn(region);
      expect(buttons.map((button) => button.textContent)).toStrictEqual([
        "Edit",
        "Retry",
        "Discard",
      ]);

      await act(async () => {
        buttons[0]?.click();
        buttons[1]?.click();
        buttons[2]?.click();
      });
      expect(edited).toStrictEqual([editToken]);
      expect(settled).toStrictEqual([
        `retry ${INTENT} @ self`,
        `discard ${INTENT} @ self`,
      ]);
    }
  );
});

const FACE_ENTRY = {
  region_id: "region-1",
  bbox: { x: 0.3, y: 0.2, w: 0.2, h: 0.25 },
  party_id: "party-ana",
  person_name: "Ana",
  matchCount: 3,
  firstSeenAt: "2026-03-02T10:00:00.000Z",
  asset: {
    asset_id: BASE_ASSET.asset_id,
    content_uri: null,
    thumb_uri: null,
    width: 1200,
    height: 800,
  },
} satisfies Record<string, PendingProjectionValue>;

interface FaceAnswerInput {
  region_id: string;
  answer: string;
}

const WRITING_VERBS = [
  "Confirm as Ana",
  "Not this person",
  "Name →",
  "Keep unnamed",
] as const;

describe("face review with an answer still in flight", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  async function review(
    intent: PendingIntentPresentationInput | null
  ): Promise<{ container: HTMLElement; writes: string[] }> {
    const entry = intent
      ? decorate("media.face_region", FACE_ENTRY.region_id, FACE_ENTRY, intent)
      : FACE_ENTRY;
    const writes: string[] = [];
    (window as unknown as { centraid: unknown }).centraid = {
      write: ({
        action,
        input,
      }: {
        action: string;
        input: FaceAnswerInput;
      }) => {
        writes.push(`${action} ${input.answer} on ${input.region_id}`);
        return Promise.resolve({ status: "executed" });
      },
      openApprovals: () => {},
      read: ({ query }: { query: string }) =>
        query === "face-queue"
          ? Promise.resolve({
              queue: [entry],
              unmatchedTotal: 1,
              confirmedTotal: 0,
              people: [{ party_id: "party-ravi", name: "Ravi" }],
            })
          : Promise.resolve({}),
    };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<FaceReview />));
    await act(async () => {});
    expect(container.textContent).toContain("Proposed: Ana");
    return { container, writes };
  }

  function verb(container: HTMLElement, label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === label
    );
    expect(found, label).toBeDefined();
    return found!;
  }

  const frozen = (container: HTMLElement): boolean[] =>
    WRITING_VERBS.map((label) => verb(container, label).disabled);

  test("an unanswered face offers every verb, and they write", async () => {
    const { container, writes } = await review(null);

    expect(container.querySelector(".kit-pending-chip")).toBeNull();
    expect(frozen(container)).toStrictEqual([false, false, false, false]);
    expect(verb(container, "Skip").disabled).toBe(false);

    await act(async () => verb(container, "Not this person").click());
    expect(writes).toStrictEqual(["answer-face reject on region-1"]);
  });

  test("a parked answer freezes the verbs instead of re-firing them", async () => {
    const { container, writes } = await review({
      intentId: INTENT,
      state: "parked",
      action: "answer-face",
    });

    expect(container.querySelector(".kit-pending-chip")?.textContent).toBe(
      "parked"
    );
    expect(container.textContent).toContain(
      "Waiting for the owner to approve this change."
    );
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Review in Approvals"
      )
    ).toBe(true);

    expect(frozen(container)).toStrictEqual([true, true, true, true]);
    expect(verb(container, "Skip").disabled).toBe(false);

    await act(async () => {
      for (const label of WRITING_VERBS) verb(container, label).click();
    });
    expect(writes).toStrictEqual([]);
  });
});
