import type { JSX, ReactNode } from "react";

import { ATLAS_EXPORT_ROW, ATLAS_KINDS_NOTE } from "../../data-copy.js";
import MeterRows from "../ui/MeterRows.js";
import type { MeterRowDef } from "../ui/MeterRows.js";
import NoteBlock from "../ui/NoteBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import {
  kindCount,
  kindMeta,
  kindWritten,
  largestRecords,
  meterShare,
} from "./atlasScreenModel.js";
import type { KindRow } from "./atlasScreenModel.js";

// A kind nothing has ever written stays in the list: dropping it left the
// head's "N of M kinds written" naming an absence the page then refused to
// explain. Census verbs are ROWS here, not app-bar verbs.

export interface AtlasKindsSectionProps {
  kinds: readonly KindRow[];
  /**
   * Caption "of M" is THIS LIST before chips, never a census total from
   * elsewhere. NOT `totals.kinds` (blueprint-only) while the list carries
   * blueprint AND machinery packs — that prints "131 of 79 kinds".
   */
  totalKinds: number;
  meta: string;
  onBrowse: (logical: string) => void;
  onRelations: () => void;
  /** Verb reads its own state rather than always saying "Open". */
  relationsOpen: boolean;
  relations?: ReactNode;
  onExport: () => void;
  /** Omitted while nothing has been read. */
  stamp?: string | undefined;
  onRefresh: () => void;
  chips?: ReactNode;
  /** Absent `onToggle`, the head draws no toggle. */
  collapsed: boolean;
  onToggle?: () => void;
}

// Census note lives in `../../data-copy.js` (#805) — one sentence, one home.

export default function AtlasKindsSection({
  kinds,
  totalKinds,
  meta,
  onBrowse,
  onRelations,
  relationsOpen,
  relations,
  onExport,
  stamp,
  onRefresh,
  chips,
  collapsed,
  onToggle,
}: AtlasKindsSectionProps): JSX.Element {
  const largest = largestRecords(kinds);
  const rows: MeterRowDef[] = kinds.map((kind) => ({
    count: kindCount(kind),
    id: kind.logical,
    name: kind.label,
    pack: kind.packLabel,
    share: meterShare(kind, largest),
    when: kindMeta(kind),
    // Absent, not disabled: the row states "Nothing to browse" instead.
    ...(kindWritten(kind) ? { onOpen: () => onBrowse(kind.logical) } : {}),
  }));

  // A snapshot with no timestamp reads as live.
  const shown = `${kinds.length.toLocaleString()} of ${totalKinds.toLocaleString()} kinds · the bar is a share of the largest`;
  const caption = stamp ? `${shown} · ${stamp}` : shown;

  const verbs: RowDef[] = [
    {
      action: {
        label: relationsOpen ? "Close" : "Open",
        onClick: onRelations,
      },
      id: "relations",
      meta: "graph",
      sub: "Which kinds point at which.",
      title: "How the kinds relate",
    },
    {
      action: { label: "Export", onClick: onExport },
      id: "export",
      sub: ATLAS_EXPORT_ROW,
      title: "Export a kind",
    },
  ];

  return (
    <>
      <SectionBlock
        action={{
          hint: "Read the census again",
          label: "Refresh",
          onClick: onRefresh,
        }}
        collapsed={collapsed}
        label="What it holds"
        meta={meta}
        {...(onToggle ? { onToggle } : {})}
      />
      {collapsed ? null : (
        <>
          {chips}
          <MeterRows ariaLabel="Kinds" caption={caption} rows={rows} />
          <RowsBlock rows={verbs} stacked={relationsOpen} />
          {relationsOpen ? relations : null}
          <NoteBlock>{ATLAS_KINDS_NOTE}</NoteBlock>
        </>
      )}
    </>
  );
}
