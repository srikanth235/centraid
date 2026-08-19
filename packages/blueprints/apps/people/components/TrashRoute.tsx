// Trash (v12 handoff § 9) — the 30 days a trashed person is still restorable.
//
// THERE IS NO "EMPTY TRASH" VERB. Destruction happens on the schedule the
// purge date announces and nowhere else, so this screen offers exactly one
// commit per row — `Restore` — and closes with the sentence that says when the
// rest happens. A button that erased early would be the one act in the app with
// no undo and no waiting period.
//
// The countdown is `format.ts`'s `daysUntil`, which is the same ceiling-to-a-
// whole-day arithmetic the rest of the app counts with. A row whose `purge_at`
// is null carries NO meta: the vault did not say when, and inventing "30 days
// left" would be this screen answering for it.
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import { daysUntil } from "../format.ts";
import { EMPTY, FRAGMENTS, SENTENCES, VERBS } from "../people-copy.ts";
import type { TrashRouteProps } from "../types.ts";
import { EmptyState } from "./EmptyState.tsx";
import { Caption, Row, SkeletonBlock, Verb } from "./Shared.tsx";

export function TrashRoute(props: TrashRouteProps): ReactNode {
  if (props.loading) {
    return (
      <SkeletonBlock>
        <LoadingSkeleton rows={4} />
      </SkeletonBlock>
    );
  }

  // Past the loading gate an empty trash is a fact, and a good one: it takes
  // the one-line register rather than a first-run pitch, because there is
  // nothing here for a member to do.
  if (props.people.length === 0) {
    return <EmptyState title={EMPTY.trash} />;
  }

  return (
    <>
      {props.people.map((person) => (
        <Row
          key={person.party_id}
          avatar={person}
          name={person.name}
          strong
          {...(person.role ? { sub: person.role } : {})}
          {...(person.purge_at
            ? { meta: FRAGMENTS.daysLeft(daysUntil(person.purge_at)) }
            : {})}
          trailing={
            <Verb
              label={VERBS.restore}
              onClick={() => props.onRestore(person)}
            />
          }
        />
      ))}
      <Caption text={SENTENCES.trashPurge} />
    </>
  );
}
