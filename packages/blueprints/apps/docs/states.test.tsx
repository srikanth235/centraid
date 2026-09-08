// @vitest-environment jsdom

// Docs' honest-state cells `docs.parked` and `docs.conflict`, asserted on the
// PRODUCTION rows rather than on the shared overlay component.
//
// `_shared/PendingWriteActions.test.tsx` already proves the overlay draws the
// right chip, sentence and buttons when it is handed a decorated row. What it
// cannot prove is that a Docs row ever REACHES it: the drive draws a document
// two ways (`ListRow`, `GridCard`), and a member who parks a rename in the grid
// and finds no explanation there is in the same position as one whose row never
// carried the mark at all. So both layouts are driven here, through the same
// decorated `DriveDoc` the outbox produces — `pendingOverlayRow` is the one
// law that pairs the row with its read's sidecar, and `enrichPendingSidecar` is the one
// that later names the steward, so nothing below hand-writes an overlay field
// the shell would not have written.
//
// The third Docs cell, `docs.pending`, is NOT here on purpose: it is owned by
// `apps/desktop/tests/e2e/pending-overlay.spec.ts`, where a real offline rename
// queues in the durable replica outbox and its chip survives an Electron
// reload. A jsdom re-enactment of that would assert strictly less.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import {
  attachPendingSidecar,
  enrichPendingSidecar,
  pendingOverlayRow,
  pendingSidecarOf,
  pendingUpsert,
} from "../_shared/pending-overlay.ts";
import type {
  PendingIntentPresentationInput,
  PendingProjectionValue,
} from "../_shared/pending-overlay.ts";
import { GridCard } from "./components/Grid.tsx";
import { ListRow } from "./components/List.tsx";
import type { DriveDoc } from "./types.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const INTENT = "intent-docs-rename";

const BASE: DriveDoc = {
  document_id: "doc-1",
  content_id: "content-1",
  title: "Lease agreement.pdf",
  media_type: "application/pdf",
  byte_size: 12_345,
  poster_uri: null,
  created_at: "2026-08-01T09:00:00.000Z",
  updated_at: "2026-08-20T09:00:00.000Z",
  folder_id: null,
  starred: false,
  trashed: false,
  purge_at: null,
  tags: [],
  custody_state: "replicated",
  shared_with: [],
  shared_from: null,
};

/** The row exactly as the outbox hands it to the drive: a projected upsert of
 *  the document, decorated with the intent's presentation fields. */
function pendingDoc(intent: PendingIntentPresentationInput): DriveDoc {
  return pendingOverlayRow(
    pendingUpsert(
      "document",
      BASE.document_id,
      BASE as unknown as Record<string, PendingProjectionValue>
    ),
    intent
  ) as unknown as DriveDoc;
}

const PARKED = pendingDoc({
  intentId: INTENT,
  state: "parked",
  action: "rename",
});

/** The same parked row after the shell learned WHO is holding it. */
const PARKED_WITH_STEWARD = attachPendingSidecar(
  { ...(PARKED as unknown as Record<string, unknown>) },
  enrichPendingSidecar(pendingSidecarOf(PARKED), [
    { intentId: INTENT, status: "parked", stewardLabel: "Ravi" },
  ])
) as unknown as DriveDoc;

const CONFLICTED = pendingDoc({
  intentId: INTENT,
  state: "conflict",
  action: "rename",
  conflict: { expectedVersion: 4, actualVersion: 5 },
});

/** The two production layouts of one document, rendered from the same row. */
const VIEWS = [
  [
    "list",
    (doc: DriveDoc, onOpenDetails: (id: string) => void) => (
      <ListRow
        doc={doc}
        index={0}
        selectedIds={new Set<string>()}
        selecting={false}
        owner={{ name: "You", initial: "Y" }}
        narrow={false}
        search=""
        trashed={false}
        offline={false}
        folderName={() => "Papers"}
        onOpenDetails={onOpenDetails}
        onOpenQuick={() => {}}
        onToggleSelect={() => {}}
        onOpenMenu={() => {}}
        onRestore={() => {}}
      />
    ),
  ],
  [
    "grid",
    (doc: DriveDoc, onOpenDetails: (id: string) => void) => (
      <GridCard
        doc={doc}
        index={0}
        offline={false}
        trashed={false}
        selectedIds={new Set<string>()}
        selecting={false}
        onOpenDetails={onOpenDetails}
        onOpenQuick={() => {}}
        onToggleSelect={() => {}}
      />
    ),
  ],
] as const;

describe("a Docs row whose write has not landed", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  /** Render one layout and return the row's pending region, which the overlay
   *  labels for a screen reader — the drive's other buttons stay outside it. */
  async function paint(
    view: (typeof VIEWS)[number][1],
    doc: DriveDoc,
    onOpenDetails: (id: string) => void = () => {}
  ): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(view(doc, onOpenDetails)));
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
    "%s: a parked rename says who is waiting and offers the Approvals inbox",
    async (_name, view) => {
      // Recorders rather than spies: what is asserted is the shell call the
      // press PRODUCED, arguments and all, not that some mock ran.
      const opened: string[] = [];
      (window as unknown as { centraid: unknown }).centraid = {
        openApprovals: () => opened.push("approvals"),
      };

      const region = await paint(view, PARKED);

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
    "%s: a named steward replaces the generic owner sentence",
    async (_name, view) => {
      (window as unknown as { centraid: unknown }).centraid = {};

      const region = await paint(view, PARKED_WITH_STEWARD);

      expect(region.textContent).toContain("Waiting for Ravi.");
      // …and does not ALSO say it the vague way, which would be the same fact
      // told twice at two levels of precision.
      expect(region.textContent).not.toContain(
        "Waiting for the owner to approve this change."
      );
    }
  );

  test.each(VIEWS)(
    "%s: with no Approvals door, the row still names where the change went",
    async (_name, view) => {
      // A shell build without the inbox (`openApprovals` absent) must not draw
      // a button that would do nothing when pressed — but the member is still
      // owed the destination, so the affordance degrades to the sentence.
      (window as unknown as { centraid: unknown }).centraid = {};

      const region = await paint(view, PARKED);

      expect(region.textContent).toContain("Review in Approvals.");
      expect(
        buttonsIn(region).map((button) => button.textContent)
      ).toStrictEqual([]);
    }
  );

  test.each(VIEWS)(
    "%s: a conflict prints both versions and offers edit, retry and discard",
    async (_name, view) => {
      const settled: Array<[string, string, string | undefined]> = [];
      const detailed: string[] = [];
      const onOpenDetails = (id: string): void => void detailed.push(id);
      (window as unknown as { centraid: unknown }).centraid = {
        retryPendingWrite: (intentId: string, scope?: string) => {
          settled.push(["retry", intentId, scope]);
          return Promise.resolve(true);
        },
        discardPendingWrite: (intentId: string, scope?: string) => {
          settled.push(["discard", intentId, scope]);
          return Promise.resolve(true);
        },
      };

      const region = await paint(view, CONFLICTED, onOpenDetails);

      expect(region.querySelector(".kit-pending-chip")?.textContent).toBe(
        "conflict"
      );
      // The two numbers are the whole reason this is a conflict rather than a
      // failure: they are what tells the member their edit was made against a
      // row somebody else has since moved on from.
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
      // Edit reopens THIS document's own details rail — a conflict that sent a
      // member to some other row would be worse than no way back at all.
      expect(detailed).toStrictEqual([BASE.document_id]);
      // Both acts name the intent the row is carrying, and no scope id: on a
      // personal drive row the shell settles it in the caller's own vault.
      expect(settled).toStrictEqual([
        ["retry", INTENT, undefined],
        ["discard", INTENT, undefined],
      ]);
    }
  );
});
