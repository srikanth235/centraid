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
  me: string | null;
  groupName?: string;
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
