// The document row's quick-actions menu, as a model (handoff Part 2 §"The
// document row"; #821).
//
// One menu for both of the row's doors — the 44×44 `···` and press-and-hold —
// built here as plain data so the composition is testable: which verbs a row
// offers is a fact about the DOCUMENT (trashed? starred? renameable?), not
// about whichever screen happened to draw it. `DriveList.tsx` renders the
// groups through the kit's `AnchoredMenu` and adds nothing.
//
// Trash carries NO destroy verb, here or anywhere: a trashed row offers
// Restore and nothing else — destruction happens only on the schedule its
// purge date announces (§14, and `TRASH_FALLBACK`'s one sentence).

import type { Folder } from "@centraid/blueprints/apps/docs/types";

import type {
  MenuActionRow,
  MenuGroup,
  MenuRow,
} from "../../kit/components/AnchoredMenu";
import {
  READ_ONLY_SOURCE_REASON,
  refusedLabel,
} from "../../kit/replica/row-provenance";
import type { MobileDriveDoc } from "./docs-projection";

export interface DocMenuHandlers {
  /** Push the one read route — it renders reading-or-facts by kind. */
  open: () => void;
  versions: () => void;
  properties: () => void;
  star: () => void;
  unstar: () => void;
  rename: () => void;
  /** Refile into a folder, or `null` for the drive's top level. */
  moveTo: (folderId: string | null) => void;
  trash: () => void;
  restore: () => void;
}

export function buildDocMenu(
  doc: Pick<MobileDriveDoc, "trashed" | "starred" | "folder_id"> & {
    /** The row's OWN canonical role (#880): the five writing verbs degrade
     *  together off it, and the three reads never do. */
    canWrite?: boolean;
  },
  folders: readonly Folder[],
  on: DocMenuHandlers
): MenuGroup[] {
  const writable = doc.canWrite !== false;
  const refuse = (label: string): string =>
    writable ? label : refusedLabel(label, READ_ONLY_SOURCE_REASON);

  if (doc.trashed) {
    // Restore puts its folder and its star back exactly as they were; the
    // slot's purge countdown is the only other thing a trashed row says.
    return [
      {
        key: "trash",
        rows: [
          {
            key: "restore",
            label: refuse("Restore"),
            disabled: !writable,
            onSelect: on.restore,
          },
        ],
      },
    ];
  }

  const openGroup: MenuRow[] = [
    { key: "open", label: "Open", onSelect: on.open },
    { key: "versions", label: "Versions", onSelect: on.versions },
    { key: "properties", label: "Properties", onSelect: on.properties },
  ];

  const moveRows: MenuActionRow[] = [
    {
      key: "move:top",
      label: "No folder",
      checked: doc.folder_id === null,
      disabled: !writable,
      onSelect: () => on.moveTo(null),
    },
    ...folders.map(
      (folder): MenuActionRow => ({
        key: `move:${folder.folder_id}`,
        label: folder.name,
        checked: doc.folder_id === folder.folder_id,
        disabled: !writable,
        onSelect: () => on.moveTo(folder.folder_id),
      })
    ),
  ];

  const actGroup: MenuRow[] = [
    doc.starred
      ? {
          key: "unstar",
          label: refuse("Unstar"),
          disabled: !writable,
          onSelect: on.unstar,
        }
      : {
          key: "star",
          label: refuse("Star"),
          disabled: !writable,
          onSelect: on.star,
        },
    {
      key: "rename",
      label: refuse("Rename…"),
      disabled: !writable,
      onSelect: on.rename,
    },
    // "A folder is a label on the document" — moving is retagging, so the
    // whole label set fits in one submenu rather than a picker screen. A
    // submenu row carries no `disabled`, so the refusal rides on its rows.
    { key: "move", label: refuse("Move to"), rows: moveRows },
  ];

  return [
    { key: "openings", rows: openGroup },
    { key: "acts", rows: actGroup },
    {
      key: "trash",
      rows: [
        {
          key: "trash",
          label: refuse("Trash"),
          destructive: true,
          disabled: !writable,
          onSelect: on.trash,
        },
      ],
    },
  ];
}
