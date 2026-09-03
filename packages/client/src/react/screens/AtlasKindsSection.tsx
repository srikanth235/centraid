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

export interface AtlasKindsSectionProps {
  kinds: readonly KindRow[];
  totalKinds: number;
  meta: string;
  onBrowse: (logical: string) => void;
  onRelations: () => void;
  relationsOpen: boolean;
  relations?: ReactNode;
  onExport: () => void;
  stamp?: string | undefined;
  onRefresh: () => void;
  chips?: ReactNode;
  collapsed: boolean;
  onToggle?: () => void;
}

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
    ...(kindWritten(kind) ? { onOpen: () => onBrowse(kind.logical) } : {}),
  }));

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
