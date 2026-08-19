// Log a touch (v12 handoff § Screens 5) — the app's most repeated act.
//
// ONE SCREEN, THREE DECISIONS, NO SCROLLING: who it was about (stated, not
// chosen), what kind it was, and an optional note. Everything above that —
// what the write does, what the status line says — belongs to `writes.ts` and
// the frame; this screen only reports the draft and the two commits.
//
// The person is whichever row the caller had in hand: the full record when the
// person screen opened it, the roster row when a `Log` verb on Touch did
// (`app-root.tsx`). Both carry a name, a hue and a last contact, which is
// everything this screen states about them.
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import { whenLabel } from "../format.ts";
import { FIELDS, LOG_KINDS, VERBS } from "../people-copy.ts";
import type { LogRouteProps } from "../types.ts";
import { ChipRow, Commits, Field, Row, SkeletonBlock } from "./Shared.tsx";

export function LogRoute(props: LogRouteProps): ReactNode {
  const person = props.person;
  const draft = props.draft;
  // A composer with no subject and no draft has nothing to compose: it is a
  // read still in flight, never an empty state, so it holds the shape the
  // screen is about to take rather than claiming there is nothing to log.
  if (props.loading || !person || !draft) {
    return (
      <SkeletonBlock>
        <LoadingSkeleton rows={3} />
      </SkeletonBlock>
    );
  }

  return (
    <section aria-label="Log a touch">
      <Row
        avatar={person}
        name={person.name}
        strong
        sub={whenLabel(person.last_contacted_at ?? person.created_at)}
        subNumeric
      />

      {/* The chip's word IS the word the vault stores (`people-copy.ts`), so a
          kind cannot be labelled one thing and written as another. */}
      <ChipRow
        label="Kind"
        options={LOG_KINDS.map((kind) => ({ id: kind, label: kind }))}
        active={draft.kind}
        onSelect={(kind) => props.onChange({ kind })}
      />

      <Field
        label={FIELDS.note}
        value={draft.text}
        placeholder={FIELDS.notePlaceholder}
        onChange={(text) => props.onChange({ text })}
      />

      <Commits narrow={props.narrow}>
        <button
          type="button"
          className="kit-btn primary"
          onClick={props.onSave}
        >
          {VERBS.log}
        </button>
        <button
          type="button"
          className="kit-btn quiet"
          onClick={props.onCancel}
        >
          {VERBS.cancel}
        </button>
      </Commits>
    </section>
  );
}
