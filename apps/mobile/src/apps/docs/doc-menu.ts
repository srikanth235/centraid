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
  /** Open the grant sheet over THIS document — audience picked from People. */
  share: () => void;
  /** Push the one read route — it renders reading-or-facts by kind. */
  open: () => void;
  /** Hand the stored bytes to the OS — this seat's "Download" (see the row). */
  download: () => void;
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
    /** Whether the People roster ANSWERED (`useDocsGrantAudiences() !== null`).
     *  Opt-in, unlike `canWrite`: no roster, no Share row at all. */
    canShare?: boolean;
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
            icon: "restore",
            disabled: !writable,
            onSelect: on.restore,
          },
        ],
      },
    ];
  }

  // Every row carries its glyph, and the NAMES come from the shared table
  // (`blueprints/apps/docs/icons.ts`) rather than being picked here — this seat
  // had already drifted to a document mark where the web opens with
  // `OpenExternal`.
  const openGroup: MenuRow[] = [
    {
      key: "open",
      label: "Open",
      icon: MENU_ICON_NAMES.open,
      onSelect: on.open,
    },
    // The web writes the bytes with `<a download>`; this seat has no file
    // space beside the window, so it hands the exact stored bytes to the OS
    // share sheet — where "Save to Files" IS the download. Nothing is
    // converted either way, so the verb is the same verb.
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
    // "A folder is a label on the document" — moving is retagging, so the
    // whole label set fits in one submenu rather than a picker screen. A
    // submenu row carries no `disabled`, so the refusal rides on its rows.
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
    // Reads never degrade, so these two carry no refusal.
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

  // Grouped by CONSEQUENCE: the one verb that reaches another person stands
  // alone above the rule (design-divergences.md carries the rest).
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
