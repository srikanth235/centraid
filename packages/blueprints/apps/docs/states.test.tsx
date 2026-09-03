import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import {
  decoratePendingMutation,
  enrichPendingRows,
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

function pendingDoc(intent: PendingIntentPresentationInput): DriveDoc {
  return decoratePendingMutation(
    pendingUpsert(
      "document",
      BASE.document_id,
      BASE as unknown as Record<string, PendingProjectionValue>
    ),
    intent
  ).values as unknown as DriveDoc;
}

const PARKED = pendingDoc({
  intentId: INTENT,
  state: "parked",
  action: "rename",
});

const PARKED_WITH_STEWARD = enrichPendingRows(
  [PARKED as unknown as Record<string, unknown>],
  [{ intentId: INTENT, status: "parked", stewardLabel: "Ravi" }]
)[0] as unknown as DriveDoc;

const CONFLICTED = pendingDoc({
  intentId: INTENT,
  state: "conflict",
  action: "rename",
  conflict: { expectedVersion: 4, actualVersion: 5 },
});

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
      const opened: string[] = [];
      (window as unknown as { centraid: unknown }).centraid = {
        openApprovals: () => opened.push("approvals"),
      };

      const region = await paint(view, PARKED);

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
    "%s: a named steward replaces the generic owner sentence",
    async (_name, view) => {
      (window as unknown as { centraid: unknown }).centraid = {};

      const region = await paint(view, PARKED_WITH_STEWARD);

      expect(region.textContent).toContain("Waiting for Ravi.");
      expect(region.textContent).not.toContain(
        "Waiting for the owner to approve this change."
      );
    }
  );

  test.each(VIEWS)(
    "%s: with no Approvals door, the row still names where the change went",
    async (_name, view) => {
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
      expect(detailed).toStrictEqual([BASE.document_id]);
      expect(settled).toStrictEqual([
        ["retry", INTENT, undefined],
        ["discard", INTENT, undefined],
      ]);
    }
  );
});
// @vitest-environment jsdom
