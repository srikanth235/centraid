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
