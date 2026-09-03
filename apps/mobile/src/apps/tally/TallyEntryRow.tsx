// ONE EXPENSE, as this seat draws it.
//
// `LedgerRow` is the SHAPE and `entry-facts.ts` is the SENTENCE — the shared
// pure module both seats compose the meta line out of, so a group ledger, a
// friend's shared expenses, the feed, Trash and Search cannot each say a
// slightly different thing about the same expense.
//
// A PENDING ROW TAKES THE 2px LEADING RULE and says "not in the vault yet" in
// its own meta (§5, and STATES.md's Activity / pending cell). Both come off
// the overlay the query decorated the row with; neither is guessed here.
import React from "react";

import { entryMeta } from "@centraid/blueprints/apps/tally/entry-facts";
import type { EntryFacts } from "@centraid/blueprints/apps/tally/entry-facts";
import {
  money,
  roleSubLabel,
  roleTone,
} from "@centraid/blueprints/apps/tally/format";
import { identityInitials } from "@centraid/design";

import { LedgerRow } from "./TallyParts";

export interface TallyEntryRowProps {
  facts: EntryFacts;
  currency: string;
  me: string | null;
  groupName?: string;
  extra?: string;
  act?: { label: string; onPress: () => void };
  onPress?: () => void;
}

export default function TallyEntryRow({
  facts,
  currency,
  me,
  groupName,
  extra,
  act,
  onPress,
}: TallyEntryRowProps): React.JSX.Element {
  return (
    <LedgerRow
      initials={identityInitials(facts.paid_by_name)}
      title={facts.description}
      meta={entryMeta({
        currency,
        facts,
        me,
        ...(groupName ? { groupName } : {}),
        ...(extra ? { extra } : {}),
      })}
      figure={{
        netMinor: facts.your_amount_minor,
        text: money(facts.your_amount_minor, currency),
        sub: roleSubLabel(facts.your_role),
        tone: roleTone(facts.your_role),
      }}
      {...(facts.parked ? { chip: "PARKED", chipTone: "seam" as const } : {})}
      {...(facts.pending ? { pending: true } : {})}
      {...(act ? { act } : {})}
      {...(onPress ? { onPress } : {})}
    />
  );
}
