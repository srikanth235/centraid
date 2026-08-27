// One EXPENSE, as the ledger row draws it — the meta sentence, the figure and
// the pending overlay, assembled once for every list that shows expenses.
//
// `LedgerRow` is the SHAPE and `entry-facts.ts` is the SENTENCE. The narrowings
// (`entryFacts`, `feedFacts`) and the sentence (`entryMeta`) live in that pure
// module because the phone composes the same row out of them; nothing here may
// restate them, or the two seats would say slightly different things about the
// same expense. This file is only the web rendering of those facts.
import type { ReactNode } from "react";

import { identityInitials } from "@centraid/design";

import { entryMeta } from "../entry-facts.ts";
import type { EntryFacts } from "../entry-facts.ts";
import { money, roleSubLabel, roleTone } from "../format.ts";
import { LedgerRow } from "./LedgerRow.tsx";
import type { RowAct } from "./LedgerRow.tsx";

export interface EntryRowProps {
  facts: EntryFacts;
  currency: string;
  /** The vault owner, so "you paid" is said as "you paid". */
  me: string | null;
  /** The group this expense sits in, where the caller knows it. On a group's
   *  own ledger every row is in the same group, so naming it on each row would
   *  be the heading repeated eight times. */
  groupName?: string;
  /** A clause the caller has and the row does not — a search hit's reason, a
   *  trashed row's purge date. */
  extra?: string;
  acts?: readonly RowAct[];
  narrow?: boolean;
  onOpen?: () => void;
}

export function EntryRow(props: EntryRowProps): ReactNode {
  const { facts } = props;
  const meta = entryMeta({
    facts,
    currency: props.currency,
    me: props.me,
    ...(props.groupName === undefined ? {} : { groupName: props.groupName }),
    ...(props.extra === undefined ? {} : { extra: props.extra }),
  });

  return (
    <LedgerRow
      chip={{
        partyId: facts.paid_by,
        initials: identityInitials(facts.paid_by_name),
      }}
      title={facts.description}
      meta={meta}
      figure={{
        text: money(facts.your_amount_minor, props.currency),
        tone: roleTone(facts.your_role),
        sub: roleSubLabel(facts.your_role),
      }}
      {...(facts.parked
        ? { status: { label: "Parked", tone: "seam" as const } }
        : {})}
      {...(facts.pendingRow ? { pendingRow: facts.pendingRow } : {})}
      {...(props.acts ? { acts: props.acts } : {})}
      {...(props.narrow === undefined ? {} : { narrow: props.narrow })}
      {...(props.onOpen ? { onOpen: props.onOpen } : {})}
    />
  );
}
