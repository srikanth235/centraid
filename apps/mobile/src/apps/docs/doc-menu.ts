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
// purge date announces (§14, and `TRASH_FALLBACK`'s one sentence), and no
// Share — a grant the purge would break.
import { MENU_ICON_NAMES } from "@centraid/blueprints/apps/docs/icons";
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
  share: () => void;
  open: () => void;
  download: () => void;
  versions: () => void;
  properties: () => void;
  star: () => void;
  unstar: () => void;
  rename: () => void;
  moveTo: (folderId: string | null) => void;
  trash: () => void;
  restore: () => void;
}

export function buildDocMenu(
  doc: Pick<MobileDriveDoc, "trashed" | "starred" | "folder_id"> & {
    /** The row's OWN canonical role (#880): the five writing verbs degrade
     *  together off it, and the three reads never do. */
    canWrite?: boolean;
    canShare?: boolean;
  },
  folders: readonly Folder[],
  on: DocMenuHandlers
): MenuGroup[] {
  const writable = doc.canWrite !== false;
  const refuse = (label: string): string =>
    writable ? label : refusedLabel(label, READ_ONLY_SOURCE_REASON);

  if (doc.trashed) {
    return [
      {
        key: "trash",
        rows: [
          {
            key: "restore",
            label: refuse("Restore"),
            icon: "restore",
            disabled: !writable,
            onSelect: on.restore,
          },
        ],
      },
    ];
  }

  const openGroup: MenuRow[] = [
    {
      key: "open",
      label: "Open",
      icon: MENU_ICON_NAMES.open,
      onSelect: on.open,
    },
    {
      key: "download",
      label: "Download",
      icon: MENU_ICON_NAMES.download,
      onSelect: on.download,
    },
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

  // Order and wording follow `blueprints/apps/docs/popovers.ts`, which is the
  // same menu on the web: Rename, Move to…, the star, then the two reads, with
  // trash alone below the rule. Mobile had invented shorter labels — "Versions",
  // "Properties", "Unstar", "Trash" — so one product named the same six verbs
  // two ways depending on the surface. (Absent here: Place in a space, which
  // this seat cannot perform. Here and not on web: Share — that menu's gap.)
  const actGroup: MenuRow[] = [
    {
      key: "rename",
      label: refuse("Rename"),
      icon: MENU_ICON_NAMES.rename,
      disabled: !writable,
      onSelect: on.rename,
    },
    {
      key: "move",
      label: refuse("Move to…"),
      icon: MENU_ICON_NAMES.move,
      rows: moveRows,
    },
    doc.starred
      ? {
          key: "unstar",
          label: refuse("Remove star"),
          icon: MENU_ICON_NAMES.star,
          disabled: !writable,
          onSelect: on.unstar,
        }
      : {
          key: "star",
          label: refuse("Star"),
          icon: MENU_ICON_NAMES.star,
          disabled: !writable,
          onSelect: on.star,
        },
    {
      key: "versions",
      label: "Version history",
      icon: MENU_ICON_NAMES.history,
      onSelect: on.versions,
    },
    {
      key: "details",
      label: "Details",
      icon: MENU_ICON_NAMES.details,
      onSelect: on.properties,
    },
  ];

  const reachGroup: MenuRow[] = doc.canShare
    ? [
        {
          key: "share",
          label: refuse("Share"),
          icon: MENU_ICON_NAMES.share,
          disabled: !writable,
          onSelect: on.share,
        },
      ]
    : [];

  return [
    ...(reachGroup.length ? [{ key: "reach", rows: reachGroup }] : []),
    { key: "openings", rows: openGroup },
    { key: "acts", rows: actGroup },
    // Reads never degrade, so these two carry no refusal.
    {
      key: "trash",
      rows: [
        {
          key: "trash",
          label: refuse("Move to trash"),
          icon: MENU_ICON_NAMES.trash,
          destructive: true,
          disabled: !writable,
          onSelect: on.trash,
        },
      ],
    },
  ];
}
