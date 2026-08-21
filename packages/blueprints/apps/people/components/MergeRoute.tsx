// Merge (v12 handoff § 10) — one person kept, one folded into them.
//
// THREE BLOCKS AND ONE SENTENCE. `Keep` is the person this screen was opened
// from, `Merge in` is the duplicate, and `Result` says what survives. The
// commit does NOT merge: it opens the modal confirm `app-root.tsx` owns, which
// is the rule for the two acts no reverse write can undo (`Shared.tsx`'s
// `ConfirmPanel`).
//
// SELECTION IS THE ROW'S OWN WEIGHT. The contract hands this screen every other
// person as a candidate, so more than one row is the ordinary case and one of
// them has to read as chosen. The shared row carries no selected state and this
// screen does not get to invent one, so the picked row takes `strong` — a
// weight at the same size and leading, which cannot reflow the list as the
// choice moves.
//
// `Result` LISTS THE TWO FIELDS THE CONTRACT HOLDS. The handoff's row set is
// per field; `PersonRow` carries a name and a role, so those are the rows. A
// field the duplicate does not differ on says its own label and nothing more —
// `was <value>` is a fact about a value being replaced, and there is none.
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
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

/** One `Result` row: the surviving value, and what it replaced where the
 *  duplicate held something else. */
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
  // A field neither person filled in is not a result — an empty row under a
  // field label would be this screen reporting a value nobody holds.
  const rows = [
    resultRow(FIELDS.name, keep.name, source?.name),
    resultRow(FIELDS.role, keep.role, source?.role),
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
        {/* The destructive recipe, and disabled until there is a duplicate to
            fold in — a merge with no source is a write with no object. */}
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
