import type { JSX } from "react";

import { ATLAS_REACH_NOTE, ATLAS_REACH_SUB } from "../../data-copy.js";
import NoteBlock from "../ui/NoteBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";

// "Who can reach it" — the second of the Vault surface's three questions (v11).
//
// THREE POINTERS, NO COPIES, and that is the whole design. Every fact this
// section could restate — which apps hold a store, which grants answer without
// asking again, what enrichment reads — is already authored somewhere a member
// can change it. A second list of grants is a second thing to keep true, and
// the first time the two disagree the member has no way to know which one the
// gateway obeys.
//
// So the rows carry no counts either. A count is a copy: it is read from one
// place and drawn in another, and it goes stale exactly as silently as a list
// would. Each row names the question and the place that answers it.

export interface VaultReachSectionProps {
  /** Notifications — where a decision about a store or a grant is answered. */
  onOpenApprovals: () => void;
  /** Settings → Enrichment — what Centraid reads of the member's own data. */
  onOpenEnrichment: () => void;
  /** Disclosure state — the parent owns it, and renders no body when closed. */
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
