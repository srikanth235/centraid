// @vitest-environment jsdom

// Photos' honest-state cells `photos.pending`, `photos.parked` and
// `photos.conflict`, asserted on the PRODUCTION surfaces rather than on the
// shared overlay component.
//
// `_shared/PendingWriteActions.test.tsx` already proves the overlay draws the
// right chip, sentence and buttons once it is handed a decorated row. What it
// cannot prove is that a Photos row ever REACHES it, and Photos has three
// places a member can be standing when a write does not land:
//
//   * the timeline TILE (components/Tile.tsx), which mounts the overlay only
//     when the row carries one — a tile is four slots and nothing else, so a
//     missing mark is a silently vanished write;
//   * the ALBUM CARD (components/AlbumGrid.tsx), a different component with a
//     different row type, where renaming or creating an album parks;
//   * FACE REVIEW (components/FaceReview.tsx), which is not a row at all but a
//     one-proposal-at-a-time queue whose every verb is a write.
//
// Face review earns its own section because the mark is not the whole claim
// there. A queue that keeps offering `Confirm as Ana` while the last answer is
// still parked invites the member to answer the same face twice, and the second
// press is a write against a row the vault has not yet moved — so this file
// pins that a pending answer FREEZES the verbs rather than re-firing them, and
// that `Skip`, which writes nothing, stays live.
//
// Nothing below hand-writes an overlay field: `pendingOverlayRow` over
// `pendingUpsert` is the one law that stamps them, exactly as the shell's
// outbox does, so a change to the field names fails here rather than passing
// against a stale transcription.
//
// The fourth designed state, `photos.stale`, is deliberately NOT here: this app
// has no stale surface distinct from offline. `library-store.ts` records a
// per-scope `error`, and `app-root.tsx` folds it into `readFailed`, which draws
// the offline banner — the cell `photos.offline` already owns.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import {
  pendingOverlayRow,
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

/** One library row, as `queries/library.ts` joins it. No `content_uri` and no
 *  `thumb_uri`, so the tile paints its own placeholder and never reaches for
 *  bytes jsdom cannot decode — the pending mark is orthogonal to the media. */
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

/** One album row, as the Albums shelf draws it. */
const BASE_ALBUM = {
  album_id: "alb-cornwall",
  title: "Cornwall 2024",
  count: 12,
} satisfies Record<string, PendingProjectionValue>;

/** The row exactly as the outbox hands it to a shelf: a projected upsert of the
 *  row, decorated with the intent's presentation fields. */
function decorate(
  entity: string,
  rowId: string,
  values: Record<string, PendingProjectionValue>,
  intent: PendingIntentPresentationInput
): Record<string, PendingProjectionValue> {
  return pendingOverlayRow(pendingUpsert(entity, rowId, values), intent);
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

/**
 * The two row surfaces of the library, each drawn from its own decorated row,
 * paired with the token its `Edit` affordance must hand back. The tile's token
 * is `assetKey` — the `(scope, asset_id)` pair, not the bare id — because an
 * Edit that resolved to a colliding id in another scope would reopen the wrong
 * photograph (asset-key.ts).
 */
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

  /** Render one surface and return the row's pending region, which the overlay
   *  labels for a screen reader — the shelf's other controls stay outside it. */
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
      // The chip's own title carries the sentence, because a queued row is the
      // one status that does not print it inline — the word alone would leave a
      // member wondering whether their photograph is safe.
      expect(
        region.querySelector(".kit-pending-chip")?.getAttribute("title")
      ).toBe("Waiting for a connection.");
      expect(region.getAttribute("aria-label")).toBe(
        "Pending change: Waiting for a connection."
      );
      // A write that has not been refused offers nothing to retry or discard:
      // those controls appear when something has gone wrong, not while it is
      // simply still on its way.
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
      // The sentence, not only the word: "parked" alone tells a member nothing
      // about what will unpark it.
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
      // What the member's three presses actually asked the shell to do, in
      // order, recorded as the settlement calls the shell would receive.
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
      // The two numbers are the whole reason this is a conflict rather than a
      // failure: they say the member's change was made against a row somebody
      // else has since moved on from.
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
      // Edit reopens THIS row — a conflict that sent a member to some other
      // photograph would be worse than no way back at all.
      expect(edited).toStrictEqual([editToken]);
      // No scope id on a personal row, so the shell is asked to settle the
      // intent against the member themselves — no shared scope.
      expect(settled).toStrictEqual([
        `retry ${INTENT} @ self`,
        `discard ${INTENT} @ self`,
      ]);
    }
  );
});

/** One unmatched face, as `queries/face-queue.ts` hands it to the review. */
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

/** The one command every verb on the review places (`actions/answer-face.ts`). */
interface FaceAnswerInput {
  region_id: string;
  answer: string;
}

/** Every control on the review that fires `answer-face`. `Skip` is excluded on
 *  purpose: it writes nothing, so it is the control that proves the freeze is
 *  about the pending WRITE and not about the screen going inert. */
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

  /** Mount the real review over a stubbed host bridge and wait for its own
   *  first read to land. Only the bridge is stubbed — the queue, the cursor and
   *  every control below it are the shipped ones. */
  async function review(
    intent: PendingIntentPresentationInput | null
  ): Promise<{ container: HTMLElement; writes: string[] }> {
    const entry = intent
      ? decorate("media.face_region", FACE_ENTRY.region_id, FACE_ENTRY, intent)
      : FACE_ENTRY;
    // Every command this screen places, recorded as the vault would see it.
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
              // Somebody else is already named, so `Name →` is never disabled
              // for want of a roster — only ever by the pending write.
              people: [{ party_id: "party-ravi", name: "Ravi" }],
            })
          : Promise.resolve({}),
    };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<FaceReview />));
    // The review loads itself in a microtask off its mount effect; flushing
    // once more inside `act` settles that read and its render.
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

    // The control case: nothing is pending, so nothing is frozen. Without it,
    // the freeze asserted below would also pass on a screen that is simply
    // broken, or on verbs that were never wired to a command at all.
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

    // The proposal itself carries the explanation — the member is not left to
    // work out why the buttons stopped responding.
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
    // Skip stays live: it writes nothing, so a parked answer has no claim on
    // the member's ability to move past this face.
    expect(verb(container, "Skip").disabled).toBe(false);

    // …and pressing the frozen verbs writes nothing. A second `answer-face`
    // against a region the vault has not moved is the silent re-fire this cell
    // exists to forbid.
    await act(async () => {
      for (const label of WRITING_VERBS) verb(container, label).click();
    });
    expect(writes).toStrictEqual([]);
  });
});
