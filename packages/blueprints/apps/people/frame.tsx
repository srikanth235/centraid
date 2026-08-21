// What People contributes to the FRAME (v12 handoff § Screens, § Navigation).
//
// The contribution SHAPE is `_shared/app-frame.tsx`, the same module Docs and
// Photos fill in. This file is what People puts in it: the title, the count
// and the one or two verbs each screen carries — and nothing about how any of
// them look, because the bar is the frame's.
//
// ONE FILLED CONTROL PER VIEW. `Add` is the roster's commit and takes the
// fill; `Trash` beside it is an outline, and every nested screen's verb is an
// outline too, because the filled element on those screens is their own
// commit further down the page.
import type { ReactNode } from "react";

import { countLabel } from "../_shared/app-frame.tsx";
import type { AppBarBase } from "../_shared/app-frame.tsx";
import type {
  InlineAppBarContribution,
  InlineBandClaim,
} from "../inline-types.ts";
import { APP_TITLE, SEARCH_TITLE, TOUCH_TITLE, VERBS } from "./people-copy.ts";
import {
  BAND_DESTINATIONS,
  EDIT,
  LOG,
  MERGE,
  PERSON,
  SEARCH,
  TOUCH,
  TRASH,
  bandTabFor,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

export interface AppBarState extends AppBarBase {
  shelf: ShelfId;
  /** The open person's name — a nested screen carries the person's OWN title,
   *  not the app's, because the person is what it is about. */
  personName?: string;
  /** Compose a new person. Only the roster has it. */
  onAdd?: () => void;
  /** Reach the trash. Only the roster has it. */
  onTrash?: () => void;
  /** Edit the open person. Only the person screen has it. */
  onEdit?: () => void;
  /** `<k> of <m> linked` — the roster's meta on a pointer surface, present
   *  only while the sharing plane answered. It REPLACES the people count
   *  rather than standing beside it: the bar carries one meta, and the linked
   *  pair already names the total. */
  linkedMeta?: string;
}

/** The bar's title for a shelf. */
export function barTitle(state: AppBarState): string {
  if (state.shelf === TOUCH) return TOUCH_TITLE;
  if (state.shelf === SEARCH) return SEARCH_TITLE;
  if (state.shelf === TRASH) return VERBS.trash;
  if (state.shelf === EDIT) return VERBS.edit;
  if (state.shelf === LOG) return VERBS.log;
  if (state.shelf === MERGE) return VERBS.merge;
  if (state.shelf === PERSON) return state.personName ?? APP_TITLE;
  return APP_TITLE;
}

/** The bar's count, in the words the product uses. `null` contributes nothing
 *  rather than a zero the view had to invent. */
export function barCount(state: AppBarState): ReactNode {
  if (state.linkedMeta) return state.linkedMeta;
  if (state.count === null) return undefined;
  return countLabel(state.count, "people");
}

export function appBar(state: AppBarState): InlineAppBarContribution {
  const onAdd = state.onAdd;
  const onTrash = state.onTrash;
  const onEdit = state.onEdit;
  const actions: ReactNode = (
    <>
      {onTrash ? (
        <button type="button" className="kit-btn" onClick={onTrash}>
          {VERBS.trash}
        </button>
      ) : null}
      {onEdit ? (
        <button type="button" className="kit-btn" onClick={onEdit}>
          {VERBS.edit}
        </button>
      ) : null}
      {onAdd ? (
        <button type="button" className="kit-btn primary" onClick={onAdd}>
          {VERBS.add}
        </button>
      ) : null}
    </>
  );
  return { title: barTitle(state), count: barCount(state), actions };
}

/**
 * The compact band claim — People's three destinations (handoff deviation 2).
 *
 * NO `More`. The frame offers the sixth slot only when an app gives it
 * something to open, and People has three destinations and no overflow: a More
 * tab that opened an empty sheet would be a destination naming nothing. That
 * is why this builds the claim directly instead of going through
 * `_shared/app-frame.tsx`'s four-argument helper, whose last argument is the
 * More handler.
 */
export function bandClaim(
  shelf: ShelfId,
  onSelect: (segment: string) => void
): InlineBandClaim {
  const activeId = bandTabFor(shelf);
  return {
    destinations: BAND_DESTINATIONS,
    ...(activeId ? { activeId } : {}),
    onSelect,
  };
}
