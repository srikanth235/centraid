// The Sharing shelf's body (v4 handoff §H, CHANGELOG H, proto 4235-4253).
//
// SHARING IS A PLACE A PHOTOGRAPH IS IN, NOT A PERMISSION ATTACHED TO IT. That
// is the whole shelf, and until now nothing said it: the shelf drew the same
// justified grid as every other one, and a member arriving at it learned
// neither where those photographs are nor what putting one there does.
//
// EVERY NUMBER IS COUNTED OFF THE ROWS THIS APP ALREADY HOLDS, in the manner
// components/Storage.tsx established. Where a fact is not knowable from them
// this screen says nothing rather than a plausible thing — and one whole
// section of the prototype used to be missing for exactly that reason:
//
//   * WHO HOLDS A GRANT (proto 4243-4248: "Ana Whitcombe · read · since 14
//     March") IS NOW DRAWN, WHERE THE HOST ANSWERS IT (issue #712, P7). The
//     shell hands an inline app `InlineScope.audience` — name + role per
//     member holding a role in that scope — resolved gateway-side by
//     `MemberStore.membersOf` and threaded through the scopes plane. There is
//     still no `since` date anywhere in this app's reach, so that half of the
//     prototype's line stays unsaid; and a scope whose `audience` the host
//     left undefined (an older gateway, one that answers no roster at all)
//     draws NOTHING for that place, never an empty list implying nobody holds
//     one — the gap is reported, not papered over.
//   * MOVE INTO SHARING (proto 4250) IS STILL NOT OFFERED, but not because
//     nothing exists to fire: `moveOutOfVault` (packages/vault/src/share
//     /placement.ts) and the gateway's placement route's `kind: "move"`
//     (packages/gateway/src/routes/placement-routes.ts) both exist and are
//     wired end to end. This app simply never calls them — the three ways IN
//     it fires are copy and remove (`copy-into-scope` / `remove-from-scope` in
//     selection-actions.ts), and a control this shelf does not yet drive is
//     worse than a missing one, so the row stays absent until it does.
//
// WHAT THE FACTS LIST IS. The prototype's panel carries four fact pairs, two
// of which are per-place counts ("your personal vault · 6,214 photographs",
// "sharing · 214"). Those two generalise to the places actually mounted here —
// a member may be in several audiences, or in none — so the list is one row
// per place, counted from the same merged rows the grid below is drawn from.
// The other two pairs are claims about grants, and they go with the grant
// section, for the reason above.
import type { InlineScope } from "../../inline-types.ts";
import { orderedScopes } from "../filters.ts";
import { shareDestinationReason } from "../sharing.ts";
import { SHARING } from "../shelves.ts";
import type { Asset } from "../types.ts";
import { emptyCopy } from "../view-copy.ts";

import styles from "./Sharing.module.css";

/** One place outside the member's own library, with what it actually holds. */
export interface SharingPlace {
  id: string;
  /** The shell's own label — never a storage noun, and the owner may rename
   *  it, so nothing here is ever derived from it (issue #599, §H). */
  label: string;
  count: number;
  canWrite: boolean;
  /** Is this where the member's own shares go (`shareTargetVaultId`)? */
  isDestination: boolean;
  /** Who holds a role here — the P7 grant roster (issue #712). Absent, never
   *  `[]`, when the host does not answer the question. */
  audience?: readonly { memberId: string; name: string; role: string }[];
}

/** What the Sharing shelf may say about itself, read off the loaded rows. */
export interface SharingFacts {
  ownLabel: string;
  ownCount: number;
  /** Everything the shelf is showing — the sum of `places`. */
  total: number;
  /** Older photographs exist beyond the loaded window, so the counts are a
   *  floor and the copy says so. */
  truncated: boolean;
  places: SharingPlace[];
  /** Why there is nowhere to share to, or null when the pointer resolves. */
  destinationReason: string | null;
}

export function sharingFacts(input: {
  /** The Sharing shelf's own list: everything shown from somewhere other than
   *  the member's own place (app-root.tsx `albumAssets`). */
  shared: readonly Asset[];
  ownCount: number;
  scopes: readonly InlineScope[];
  ownScopeId: string;
  /** The member's share-destination pointer, when the host names one. */
  shareTargetId?: string;
  truncated: boolean;
}): SharingFacts {
  const counts = new Map<string, number>();
  for (const asset of input.shared) {
    const id = asset.scope_id ?? "";
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const places = orderedScopes(input.scopes, input.shareTargetId)
    .filter((scope) => scope.id !== input.ownScopeId)
    .map((scope) => ({
      id: scope.id,
      label: scope.label,
      count: counts.get(scope.id) ?? 0,
      canWrite: scope.canWrite,
      isDestination: scope.id === input.shareTargetId,
      ...(scope.audience === undefined ? {} : { audience: scope.audience }),
    }));
  return {
    ownLabel:
      input.scopes.find((scope) => scope.id === input.ownScopeId)?.label ??
      "Library",
    ownCount: input.ownCount,
    total: input.shared.length,
    truncated: input.truncated,
    places,
    destinationReason: shareDestinationReason(
      input.scopes,
      input.shareTargetId
    ),
  };
}

/**
 * Final copy. It lives beside the view rather than in view-copy.ts because
 * these strings are read nowhere else; the prototype's own words, minus the
 * storage noun for a place, which this app may never print (issue #599).
 */
const SHARING_COPY = {
  eyebrow: "How sharing works here",
  title: "Sharing is a place, not a switch on a photograph",
  lede: "Your own library is reachable by nothing. Sharing is somewhere else, so other people can be given something without being given your library. A photograph is shared because it sits there — and it stops being shared the moment it leaves, with no permission left behind to forget about.",
  countsHead: "What is where",
  /** Only drawn for a place whose `audience` the host actually answered
   *  (issue #712, P7) — see the header note on why an unanswered place stays
   *  silent rather than reading as "nobody else". */
  rosterHead: "Who has access",
  windowNote: (shown: number) =>
    `These counts cover the ${shown} photographs loaded here. Older ones are still in your library — open Show more on the timeline to reach them.`,
  readOnly: "read only",
  /** Which of several places is the one the member's own shares go to. A
   *  household audience somebody else owns is in this list too, and the two
   *  are not the same thing to a member deciding where to put a photograph. */
  destination: "where your shares go",
  waysHead: "Putting a photograph in",
  waysMeta: "reversible either way",
  copyLabel: "Copy into Sharing",
  copySub:
    "the photograph is in both places. Editing the caption in one does not touch the other.",
  copyAction: "Open your library",
  removeLabel: "Take it back out",
  removeSub:
    "select here and remove. It stops being shared the moment it leaves.",
  removeAction: "Select photographs",
  removeEmpty: "Nothing is here to take back out.",
  nowHead: "In Sharing now",
  nowMeta: (n: number) => `${n} · newest first`,
} as const;

function Head({ label, meta }: { label: string; meta?: string }) {
  return (
    <h2 className={styles.head}>
      <span className={styles.headLabel}>{label}</span>
      {meta ? <span className={styles.headMeta}>{meta}</span> : null}
    </h2>
  );
}

/** One way in: what it does, and the control that starts it. A control that
 *  cannot fire stands disabled carrying the reason, never absent (README:233). */
function Way({
  label,
  sub,
  action,
  reason,
  onAct,
}: {
  label: string;
  sub: string;
  action: string;
  reason: string | null;
  onAct: () => void;
}) {
  return (
    <div className={styles.way}>
      <div className={styles.wayText}>
        <p className={styles.wayLabel}>{label}</p>
        <p className={styles.waySub}>{reason ?? sub}</p>
      </div>
      <button
        type="button"
        className="kit-btn"
        disabled={reason !== null}
        {...(reason === null ? {} : { title: reason })}
        onClick={onAct}
      >
        {action}
      </button>
    </div>
  );
}

/**
 * The head of the Sharing shelf, above its grid. It also owns this shelf's
 * EMPTY state: the generic empty block would say "Nothing is in Sharing yet"
 * with none of the above, and a member who has never shared anything is
 * exactly the member who needs to be told what sharing is.
 */
export function SharingBody({
  facts,
  onOpenLibrary,
  onSelect,
}: {
  facts: SharingFacts;
  onOpenLibrary: () => void;
  onSelect: () => void;
}) {
  return (
    <section className={styles.body}>
      <p className={styles.eyebrow}>{SHARING_COPY.eyebrow}</p>
      <h2 className={styles.title}>{SHARING_COPY.title}</h2>
      <p className={styles.lede}>{SHARING_COPY.lede}</p>

      <Head label={SHARING_COPY.countsHead} />
      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt className={styles.rowLabel}>{facts.ownLabel}</dt>
          <dd className={styles.rowValue}>{facts.ownCount}</dd>
        </div>
        {facts.places.map((place) => (
          <div key={place.id} className={styles.row}>
            <dt className={styles.rowLabel}>
              {place.label}
              {place.isDestination ? (
                <span className={styles.rowNote}>
                  {" "}
                  · {SHARING_COPY.destination}
                </span>
              ) : null}
              {place.canWrite ? null : (
                <span className={styles.rowNote}>
                  {" "}
                  · {SHARING_COPY.readOnly}
                </span>
              )}
            </dt>
            <dd className={styles.rowValue}>{place.count}</dd>
          </div>
        ))}
      </dl>
      {facts.truncated ? (
        <p className={styles.note}>
          {SHARING_COPY.windowNote(facts.ownCount + facts.total)}
        </p>
      ) : null}

      {facts.places.some((place) => place.audience !== undefined) ? (
        <>
          <Head label={SHARING_COPY.rosterHead} />
          <dl className={styles.rows}>
            {facts.places.flatMap((place) =>
              (place.audience ?? []).map((member) => (
                <div
                  className={styles.row}
                  key={`${place.id}-${member.memberId}`}
                >
                  <dt className={styles.rowLabel}>
                    {member.name}
                    {facts.places.length > 1 ? (
                      <span className={styles.rowNote}> · {place.label}</span>
                    ) : null}
                  </dt>
                  <dd className={styles.rowValue}>{member.role}</dd>
                </div>
              ))
            )}
          </dl>
        </>
      ) : null}

      <Head label={SHARING_COPY.waysHead} meta={SHARING_COPY.waysMeta} />
      <Way
        label={SHARING_COPY.copyLabel}
        sub={SHARING_COPY.copySub}
        action={SHARING_COPY.copyAction}
        reason={facts.destinationReason}
        onAct={onOpenLibrary}
      />
      <Way
        label={SHARING_COPY.removeLabel}
        sub={SHARING_COPY.removeSub}
        action={SHARING_COPY.removeAction}
        reason={facts.total === 0 ? SHARING_COPY.removeEmpty : null}
        onAct={onSelect}
      />

      {facts.total === 0 ? (
        <p className={styles.note}>{emptyCopy(SHARING)}</p>
      ) : (
        <Head
          label={SHARING_COPY.nowHead}
          meta={SHARING_COPY.nowMeta(facts.total)}
        />
      )}
    </section>
  );
}
