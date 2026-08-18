// PEOPLE ON THE DESKTOP — deliberately empty, awaiting its design handoff.
//
// This file held the app's whole orchestration: a roster in list and grid, a
// per-person detail pane with contact channels, cadence, relationships, gifts,
// debts and a journal, a smart-nav sidebar, bulk selection, a trash card and
// an activity feed. All of it was drawn before the Binding Layer v11 handoff,
// so it answers a grammar the rebuild is going to replace. It is REMOVED
// rather than left in place, because a surface that is wrong still has to be
// maintained, tested and explained — and every hour spent doing that buys
// nothing the rebuild will keep.
//
// WHAT WAS NOT TOUCHED, and why: the twenty-eight `./actions/*`, the seven
// `./queries/*`, `app.json`'s vault scopes and `pending-projection.ts`. A
// design handoff redraws screens; it does not redesign the vault contract, the
// consent grant or the receipt trail. Those are still live — the assistant
// still invokes every people action through the manifest, and the Ask panel
// (`app-inline.tsx`'s `kitAsk`) still runs the queries — so the app is not
// dark, it is unrendered. That distinction is the whole reason this file
// exists at all instead of the app being deleted.
//
// The phone is in the same state: `apps/mobile/src/apps/people/PeopleHome.tsx`.
//
// The wall spends no verb. `kit-empty` is the kit's notice card and it is
// normally paired with a `kit-btn` CTA — `src/state-honesty.test.ts` asserts
// exactly that pairing for every app that draws a primary empty state, and
// People has been taken OFF that list on purpose. A CTA is a way forward, and
// there is nothing here to go forward to; a button that only restates the
// sentence above it is worse than no button.

import type { ReactElement } from "react";

import type { InlineAppProps } from "../inline-types.ts";

import styles from "./Chrome.module.css";

/**
 * Nothing is read, so nothing is subscribed. The shell uses this list to decide
 * which replica changes should re-run the app's queries; an empty UI declaring
 * fourteen tables would wake the route on every unrelated write and render the
 * same wall again.
 *
 * The retired list, so the rebuild restores it rather than rediscovering it:
 * people.profile, people.important_date, tally.obligation, schedule.task,
 * core.party, core.activity, core.link, core.content_item,
 * core.party_identifier, social.contact_channel, core.tag, core.concept,
 * knowledge.note, knowledge.annotation.
 */
export const CHANGE_TABLES: string[] = [];

export function Root({ rootRef }: InlineAppProps): ReactElement {
  return (
    <div className={styles.appRoot} ref={rootRef}>
      <div className={styles.main}>
        <div className="kit-empty">
          <div className="kit-empty-title">Not here yet</div>
          <div className="kit-empty-sub">
            People is being rebuilt from its design handoff.
          </div>
        </div>
      </div>
    </div>
  );
}
