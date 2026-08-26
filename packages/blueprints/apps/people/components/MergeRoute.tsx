// Merge (v12 handoff § 10): one person kept, one folded in.
// The commit does NOT merge — it opens the ConfirmPanel modal app-root.tsx owns
// (acts no reverse write can undo); the picked candidate row takes `strong`.
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import { cadenceLabel } from "../format.ts";
import {
  EMPTY,
  FIELDS,
  FRAGMENTS,
  MERGE_HEADS,
  SECTIONS,
  SENTENCES,
  VERBS,
} from "../people-copy.ts";
import type { MergeRouteProps, PersonRow } from "../types.ts";
import { EmptyState } from "./EmptyState.tsx";
import { Caption, Commits, Row, Section, SkeletonBlock } from "./Shared.tsx";

/** One `Result` row: the surviving value and what it replaced. */
function resultRow(
  field: string,
  kept: string,
  replaced: string | undefined
): { name: string; sub: string } {
  const differs = Boolean(replaced) && replaced !== kept;
  return {
    name: kept,
    sub: differs && replaced ? FRAGMENTS.was(field, replaced) : field,
  };
}

export function MergeRoute(props: MergeRouteProps): ReactNode {
  const keep = props.keep;
  if (props.loading || !keep) {
    return (
      <SkeletonBlock>
        <LoadingSkeleton rows={5} />
      </SkeletonBlock>
    );
  }

  const source: PersonRow | null = props.source;
  // A field neither person filled in is not a result.
  // Blank keep fields take the duplicate's value, matching core.merge_party.
  const cadenceDays =
    keep.cadence_days > 0
      ? keep.cadence_days
      : (source?.cadence_days ?? keep.cadence_days);
  const rows = [
    resultRow(FIELDS.name, keep.name, source?.name),
    resultRow(FIELDS.role, keep.role, source?.role),
    resultRow(
      FIELDS.colour,
      keep.avatar_color ?? source?.avatar_color ?? "",
      source?.avatar_color ?? undefined
    ),
    resultRow(
      FIELDS.cadence,
      cadenceLabel(cadenceDays),
      source ? cadenceLabel(source.cadence_days) : undefined
    ),
  ].filter((row) => row.name);

  return (
    <>
      <Section title={MERGE_HEADS.keep}>
        <Row
          avatar={keep}
          name={keep.name}
          strong
          {...(keep.role ? { sub: keep.role } : {})}
        />
      </Section>

      <Section
        title={MERGE_HEADS.mergeIn}
        count={props.candidates.length}
        ruled
      >
        {props.candidates.length === 0 ? (
          <EmptyState title={EMPTY.merge} />
        ) : (
          props.candidates.map((candidate) => (
            <Row
              key={candidate.party_id}
              avatar={candidate}
              name={candidate.name}
              strong={candidate.party_id === source?.party_id}
              {...(candidate.role ? { sub: candidate.role } : {})}
              onOpen={() => props.onPickSource(candidate.party_id)}
            />
          ))
        )}
      </Section>

      <Section title={SECTIONS.result} ruled>
        {rows.map((row) => (
          <Row key={row.sub} name={row.name} strong sub={row.sub} />
        ))}
      </Section>

      <Caption
        text={props.merged ? SENTENCES.merged : SENTENCES.mergeWarning}
      />

      <Commits narrow={props.narrow}>
        {/* Destructive, and disabled until there is a duplicate to fold in. */}
        <button
          type="button"
          className="kit-btn destructive"
          disabled={props.merged || !source}
          onClick={props.onMerge}
        >
          {props.merged ? VERBS.merged : VERBS.merge}
        </button>
        <button
          type="button"
          className="kit-btn quiet"
          onClick={props.onCancel}
        >
          {VERBS.cancel}
        </button>
      </Commits>
    </>
  );
}
