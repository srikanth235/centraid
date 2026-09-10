// THE DRIVE'S SELECTION, AS THE ROOM'S (#1015, D5 — audit B8).
//
// `DriveList` used to dock a bulk bar of its own under a live five-tab band,
// so a tap aimed at "Trash" could land on a band destination. It publishes the
// mode upward instead: the room swaps the header to "N documents selected ·
// Cancel", dims the band and stops it answering, and draws the one foot row.
//
// A hook rather than inline code, because `DriveList.tsx` is at its file
// ceiling and this is the one piece of it that is about the ROOM rather than
// about the list.

import { useEffect, useRef } from "react";

import type { RoomSelection } from "../../kit/rooms/room-contracts";
import type { MobileDriveDoc } from "./docs-projection";

type ActMany = (
  action: string,
  targets: readonly MobileDriveDoc[],
  label: string,
  input: (doc: MobileDriveDoc) => Record<string, string>,
  undo?: (doc: MobileDriveDoc) => {
    action: string;
    input: Record<string, string>;
  }
) => Promise<void>;

export interface DriveSelectionInput {
  selecting: boolean;
  /** How many documents are chosen; the only value the room needs to redraw. */
  chosen: number;
  pickedDocs: readonly MobileDriveDoc[];
  actMany: ActMany;
  leaveSelection: () => void;
  /** Opens the folder card; the room's foot row has no page position to hang
   *  one from, so the card takes `AnchoredMenu`'s own no-anchor corner. */
  onMoveTo: () => void;
  onSelection?: (selection: RoomSelection | undefined) => void;
}

export function useDriveSelection({
  selecting,
  chosen,
  pickedDocs,
  actMany,
  leaveSelection,
  onMoveTo,
  onSelection,
}: DriveSelectionInput): void {
  // The verbs close over the CURRENT pick and the handlers are rebuilt every
  // render, so they travel through a ref: a dependency on them would republish
  // on every render, and the screen holds this in state.
  const live = useRef({ actMany, leaveSelection, onMoveTo, pickedDocs });
  useEffect(() => {
    live.current = { actMany, leaveSelection, onMoveTo, pickedDocs };
  });

  useEffect(() => {
    if (!selecting) {
      onSelection?.(undefined);
      return;
    }
    onSelection?.({
      actions: [
        {
          disabled: chosen === 0,
          label: "Star",
          onPress: () => {
            void live.current.actMany(
              "star",
              live.current.pickedDocs.filter((doc) => !doc.starred),
              "Starred",
              (doc) => ({ document_id: doc.document_id }),
              (doc) => ({
                action: "unstar",
                input: { document_id: doc.document_id },
              })
            );
          },
        },
        {
          disabled: chosen === 0,
          label: "Move to",
          onPress: () => live.current.onMoveTo(),
        },
        {
          // Outlined `--net`, never filled: trashing is reversible and the
          // status line carries the Undo, so it is not this view's one commit.
          dangerous: true,
          disabled: chosen === 0,
          label: "Trash",
          onPress: () => {
            void live.current.actMany(
              "trash",
              live.current.pickedDocs,
              "Moved to trash",
              (doc) => ({ document_id: doc.document_id }),
              (doc) => ({
                action: "restore",
                input: { document_id: doc.document_id },
              })
            );
          },
        },
      ],
      count: chosen,
      noun: "document",
      onCancel: () => live.current.leaveSelection(),
    });
  }, [chosen, onSelection, selecting]);
}
