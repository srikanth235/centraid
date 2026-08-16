import type { JSX } from "react";

import { ATLAS_KINDS_NOTE } from "../../data-copy.js";
import NoteBlock from "../ui/NoteBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import { kindMeta, kindSubLine, kindWritten } from "./atlasScreenModel.js";
import type { KindRow } from "./atlasScreenModel.js";

// The Kinds block of the Data route (v9 §6, issue #765) — what used to be the
// periodic-table tab.
//
// Every kind the vault's schema defines, one row each: whose pack it belongs
// to, what it holds, when it was last written, and one outlined verb that opens
// it. The per-card sparkline went with the restructure (a row carries a
// sentence, not a chart), and so did the machinery shelf — a plumbing kind is a
// row in this same list, sorted below the life data, so it stays reachable
// without a second, differently-shaped table.
//
// A kind nothing has ever written is a GHOST ROW (#775): drawn `off`, with its
// verb inert, because there is nothing to browse. It is drawn rather than
// dropped because a list that silently omitted it left "showing 9 of 40" with
// no way to see the other thirty-one — the count named an absence the page then
// refused to explain.

export interface AtlasKindsSectionProps {
  /** The kinds to show — already filtered by the page's chips. */
  kinds: readonly KindRow[];
  /** Every kind the schema defines, written or not: the "of M" in the head. */
  totalKinds: number;
  /** Open a kind's records in the section below. */
  onBrowse: (logical: string) => void;
  /** The head's trailing verb: when the census was read, and a way to read it
   *  again. Omitted while nothing has been read. */
  stamp?: string | undefined;
  onRefresh: () => void;
}

// The rule this page explains once lives in `../../data-copy.js` (issue #805)
// — mobile's Data screen says it too, and one sentence has one home.

export default function AtlasKindsSection({
  kinds,
  totalKinds,
  onBrowse,
  stamp,
  onRefresh,
}: AtlasKindsSectionProps): JSX.Element {
  const rows: RowDef[] = kinds.map((kind) => {
    const meta = kindMeta(kind);
    const written = kindWritten(kind);
    return {
      action: {
        // The verb keeps its word while it is inert: hiding it would make the
        // ghost row a different SHAPE from its neighbours, which reads as a
        // different kind of thing rather than the same thing with nothing in
        // it. `off` disables it on the leaf, never as a container opacity.
        hint: written
          ? `Browse ${kind.label}`
          : `${kind.label} has no records to browse`,
        label: "Browse",
        onClick: () => onBrowse(kind.logical),
      },
      id: kind.logical,
      sub: kindSubLine(kind),
      title: kind.label,
      ...(written ? {} : { off: true as const }),
      ...(meta ? { meta } : {}),
    };
  });

  const count = `showing ${kinds.length.toLocaleString()} of ${totalKinds.toLocaleString()}`;

  return (
    <>
      <SectionBlock
        action={{
          hint: "Read the census again",
          label: "Refresh",
          onClick: onRefresh,
        }}
        label="Kinds"
        meta={stamp ? `${count} · ${stamp}` : count}
      />
      <RowsBlock ariaLabel="Kinds" rows={rows} />
      <NoteBlock>{ATLAS_KINDS_NOTE}</NoteBlock>
    </>
  );
}
