import type { JSX } from "react";

import NoteBlock from "../ui/NoteBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import { kindMeta, kindSubLine } from "./atlasScreenModel.js";
import type { KindRow } from "./atlasScreenModel.js";

// The Kinds block of the Data route (v9 §6, issue #765) — what used to be the
// periodic-table tab.
//
// Every kind the vault has actually written, one row each: its name, what it
// holds, when it was last written, and one outlined verb that opens it. The
// per-card sparkline went with the restructure (a row carries a sentence, not a
// chart), and so did the machinery shelf — a plumbing kind is a row in this
// same list, sorted below the life data, so it stays reachable without a
// second, differently-shaped table.

export interface AtlasKindsSectionProps {
  /** The kinds to show — already filtered by the page's chips. */
  kinds: readonly KindRow[];
  /** Every kind the schema defines, written or not: the "of M" in the head. */
  totalKinds: number;
  /** Open a kind's records in the section below. */
  onBrowse: (logical: string) => void;
}

/** The rule this page explains once, in the words the design brief pinned. */
export const KINDS_NOTE =
  "A kind is a shape of record an app writes. Sizes include every version kept.";

export default function AtlasKindsSection({
  kinds,
  totalKinds,
  onBrowse,
}: AtlasKindsSectionProps): JSX.Element {
  const rows: RowDef[] = kinds.map((kind) => {
    const meta = kindMeta(kind);
    return {
      action: { label: "Browse", onClick: () => onBrowse(kind.logical) },
      id: kind.logical,
      sub: kindSubLine(kind),
      title: kind.label,
      ...(meta ? { meta } : {}),
    };
  });

  return (
    <>
      <SectionBlock
        label="Kinds"
        meta={`showing ${kinds.length.toLocaleString()} of ${totalKinds.toLocaleString()}`}
      />
      <RowsBlock ariaLabel="Kinds" rows={rows} />
      <NoteBlock>{KINDS_NOTE}</NoteBlock>
    </>
  );
}
