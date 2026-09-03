import type { JSX } from "react";

import { ATLAS_REACH_NOTE, ATLAS_REACH_SUB } from "../../data-copy.js";
import NoteBlock from "../ui/NoteBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";

export interface VaultReachSectionProps {
  onOpenApprovals: () => void;
  onOpenEnrichment: () => void;
  collapsed: boolean;
  onToggle: () => void;
}

export default function VaultReachSection({
  onOpenApprovals,
  onOpenEnrichment,
  collapsed,
  onToggle,
}: VaultReachSectionProps): JSX.Element {
  const rows: RowDef[] = [
    {
      action: { label: "Open", onClick: onOpenApprovals },
      id: "holders",
      meta: "Notifications",
      sub: "Which apps and agents were given a store, and on what terms.",
      title: "Apps and agents holding a store",
    },
    {
      action: { label: "Open", onClick: onOpenApprovals },
      id: "grants",
      meta: "Notifications",
      sub: "Rules that answer for you without asking again.",
      title: "Standing grants",
    },
    {
      action: { label: "Open", onClick: onOpenEnrichment },
      id: "enrichment",
      meta: "Settings",
      sub: "Machine reading of your own data, and what leaves the gateway.",
      title: "What Centraid reads",
    },
  ];

  return (
    <>
      <SectionBlock
        collapsed={collapsed}
        label="Who can reach it"
        meta="Answered on Notifications and in Settings"
        onToggle={onToggle}
      />
      {collapsed ? null : (
        <>
          <RowsBlock ariaLabel="Who can reach it" rows={rows} />
          {/* Two lines, not one paragraph: the rule and the one place this
              page deliberately cannot point at are separate statements, and
              the copy budget is per string. */}
          <NoteBlock>{ATLAS_REACH_NOTE}</NoteBlock>
          <NoteBlock>{ATLAS_REACH_SUB}</NoteBlock>
        </>
      )}
    </>
  );
}
