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

// "What it holds" — the first of the Vault surface's three questions (v11).
//
// It was the Kinds block of the retired Data route: one `RowsBlock` row per
// kind, each carrying its pack, its counts and a Browse verb. The row said
// everything and showed nothing, so a vault with forty kinds was forty
// sentences a member had to hold in their head to find the two that matter.
// The v11 row keeps the same facts and adds a bar — share of the LARGEST kind
// — so the list reads as an ordering before it is read as text.
//
// A kind nothing has ever written stays in the list: "we hold nothing of that
// sort" is an answer a custody page owes, and dropping it left the head's
// "25 of 31 kinds written" naming an absence the page then refused to explain.
// Its trailing cell is inert text rather than a disabled button — no verb that
// does nothing.
//
// The two things a member can do to the whole census — see how the kinds
// relate, take one out — are ROWS here rather than app-bar verbs. The bar
// carries the surface's identity and its one commit ("Pair a device"); a verb
// about the census belongs beside the census, where it keeps its subject.

export interface AtlasKindsSectionProps {
  /** The kinds to show — already filtered by the chips. */
  kinds: readonly KindRow[];
  /**
   * The caption's "of M" — how many kinds are in THIS LIST before the chips
   * filtered it, never a census total from elsewhere.
   *
   * It used to be `totals.kinds`, which counts blueprint kinds only while the
   * list itself carries blueprint AND machinery packs. On a real vault that
   * printed "131 of 79 kinds" — a numerator larger than its own denominator,
   * which is not a number a member can do anything with. The head still states
   * the census's own "N of M written"; this caption is about the rows below it.
   */
  totalKinds: number;
  /** The head's own sentence: "25 of 31 kinds written · 41,208 records". */
  meta: string;
  /** Open a kind's records in the browser below. */
  onBrowse: (logical: string) => void;
  /** Open (or close) the relations drill-in. */
  onRelations: () => void;
  /** Is it open? The row's verb reads its own state rather than always
   *  saying "Open" over a chart that is already on screen. */
  relationsOpen: boolean;
  /** The relations drill-in itself, rendered under the verbs when open. */
  relations?: ReactNode;
  /** Copy out every record of the browsed kind. */
  onExport: () => void;
  /** The head's trailing verb: when the census was read, and a way to read it
   *  again. Omitted while nothing has been read. */
  stamp?: string | undefined;
  onRefresh: () => void;
  /** The chip row, when the list is long enough to need one. */
  chips?: ReactNode;
  /** Disclosure state — the parent owns it, and renders no body when closed.
   *  Absent `onToggle`, the head draws no toggle at all: a disclosure nothing
   *  can open is a verb that does nothing. */
  collapsed: boolean;
  onToggle?: () => void;
}

// The rule this page explains once lives in `../../data-copy.js` (issue #805)
// — mobile's Data screen says it too, and one sentence has one home.

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

  // The census is a snapshot, and a snapshot with no timestamp reads as live.
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
