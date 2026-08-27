// What stands OVER the room: the band's More sheet, the confirms, and the
// small sheets that mint a friend, a group or a member.
//
// ONE OVERLAY AT A TIME, and it is a value — `Overlay` in `compose-state.ts`.
// Two confirms on screen at once would be two questions with one answer
// between them, and a sheet over a confirm would put the way out behind the
// thing it was opened from.
//
// THE COMPOSING SHEETS LIVE IN THEIR OWN FILE and this one dispatches to them,
// because the four that hold FIELDS are a different kind of thing from the
// three that only hold a question — and the union that names them is what
// keeps "one at a time" true by construction rather than by care.
import type { ReactNode } from "react";

import { NUDGE_BODY, NUDGE_COMMIT, nudgeTitle } from "../compose-copy.ts";
import type { Overlay } from "../compose-state.ts";
import { moreMeta } from "../route-copy.ts";
import { MORE_SHELVES, shelfLabel } from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import type { Person } from "../types.ts";
import {
  ARCHIVE_BODY,
  ARCHIVE_BODY_2,
  ARCHIVE_TITLE,
  LEAVE_BODY,
  LEAVE_BODY_2,
  LEAVE_TITLE,
  NUDGE_PARKED,
  REMOVE_BODY,
  UNARCHIVE_BODY,
  UNARCHIVE_TITLE,
  VERBS,
  removeAsk,
  removeRefused,
  removeTitle,
} from "../view-copy.ts";
import { ComposeSheets } from "./ComposeSheets.tsx";
import { Confirm, MoreSheet } from "./Panels.tsx";

export type { Overlay } from "../compose-state.ts";

export interface OverlaysProps {
  overlay: Overlay;
  friends: readonly Person[];
  candidates: readonly Person[];
  onClose: () => void;
  onNavigate: (shelf: ShelfId) => void;
  onRemove: (partyId: string) => void;
  onName: (value: string) => void;
  onIcon: (id: string) => void;
  onColour: (id: string) => void;
  onToggleMember: (partyId: string) => void;
  onPickMember: (partyId: string) => void;
  onCommit: () => void;
}

export function Overlays(props: OverlaysProps): ReactNode {
  const open = props.overlay;
  if (!open) return null;

  if (open.kind === "more") {
    return (
      <MoreSheet
        rows={MORE_SHELVES.map((id) => ({
          id: String(id),
          name: shelfLabel(id),
          meta: moreMeta(id),
          open: () => props.onNavigate(id),
        }))}
        closeLabel={VERBS.close}
        onClose={props.onClose}
      />
    );
  }

  if (open.kind === "leave") {
    // THE §6 SENTENCE, IN TWO PARTS. It renders as one paragraph and one
    // trailing line, so a member reads the handoff's copy unaltered; holding
    // it as two literals is what keeps each of them a single claim.
    return (
      <Confirm
        title={LEAVE_TITLE}
        body={LEAVE_BODY}
        note={LEAVE_BODY_2}
        commitLabel={VERBS.leave}
        cancelLabel={VERBS.close}
        onCancel={props.onClose}
        onConfirm={props.onCommit}
      />
    );
  }

  if (open.kind === "archive") {
    const back = open.archived;
    return (
      <Confirm
        title={back ? UNARCHIVE_TITLE : ARCHIVE_TITLE}
        body={back ? UNARCHIVE_BODY : ARCHIVE_BODY}
        {...(back ? {} : { note: ARCHIVE_BODY_2 })}
        commitLabel={back ? VERBS.unarchive : VERBS.archive}
        cancelLabel={VERBS.close}
        onCancel={props.onClose}
        onConfirm={props.onCommit}
      />
    );
  }

  if (open.kind === "nudge") {
    // IT ALWAYS PARKS, and the confirm says so BEFORE the press. A reminder
    // this app could send would be a delivery path this product does not have.
    return (
      <Confirm
        title={nudgeTitle(open.name)}
        body={NUDGE_BODY}
        note={NUDGE_PARKED}
        commitLabel={NUDGE_COMMIT}
        cancelLabel={VERBS.close}
        onCancel={props.onClose}
        onConfirm={props.onCommit}
      />
    );
  }

  if (open.kind === "remove") {
    return (
      <Confirm
        title={open.refused ? removeTitle(open.name) : removeAsk(open.name)}
        body={open.refused ? removeRefused(open.name) : REMOVE_BODY}
        commitLabel={VERBS.remove}
        destructive={!open.refused}
        {...(open.refused ? { disabledReason: removeRefused(open.name) } : {})}
        cancelLabel={VERBS.close}
        onCancel={props.onClose}
        onConfirm={() => props.onRemove(open.partyId)}
      />
    );
  }

  return (
    <ComposeSheets
      overlay={open}
      friends={props.friends}
      candidates={props.candidates}
      onName={props.onName}
      onIcon={props.onIcon}
      onColour={props.onColour}
      onToggleMember={props.onToggleMember}
      onPickMember={props.onPickMember}
      onClose={props.onClose}
      onCommit={props.onCommit}
    />
  );
}
