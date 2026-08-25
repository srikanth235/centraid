// The People shelf (v4 handoff §5): the people the member has CONFIRMED, as
// cards — a square crop, the name, the count in tabular mono — and tapping one
// filters the timeline to them, exactly as opening an album does (§5: a shelf
// is the same timeline under a filter).
//
// Unconfirmed face PROPOSALS render alongside them (#711)
// — the prototype's own PPEOPLE set mixes named cards with "Unnamed" ones,
// each carrying its own count (v4 handoff proto :3760, :3942 "People as a
// browsable set. Unnamed people are shown as unnamed, not hidden."). A
// proposal is visually and structurally a DIFFERENT thing from a confirmed
// person — dashed border, its own label, its own type with no `name` field —
// because it is a different claim: `queries/people.ts` answers "who is in my
// library" for `people`, and "what has not been named or rejected yet" for
// `proposals`. Confirming a proposal is not this shelf's to do (§8's
// propose-and-confirm loop lives in Face Review); a proposal card only ever
// routes there.
//
// NOTHING REFLOWS. Every card is a square of `--skel` at its final geometry
// from the first frame; the crop paints into that square when its bytes land,
// and a person (or proposal) whose cover is outside the loaded window keeps
// the same square rather than collapsing — the same contract the tile holds
// (§14).
//
// THE CONSENT GATE LIVES HERE (#712), not behind a toolbar icon and
// a `<dialog>` a member would have to go looking for. A member who opens
// People and finds it empty has exactly the
// question the gate answers, so while the roster (and its proposals) are
// empty AND the question is still open this session, `gate` renders in place
// of the grid/note — the empty shelf IS the gate's body. `app-root.tsx`
// decides when that is true (`enrichment-gate.ts`); this component stays a
// pure view either way, same as `EnrichmentConsent` itself.
import { faceCropStyle } from "../../_shared/face-crop.ts";
import { mountMedia } from "../media.ts";
import type { FaceProposal, Person } from "../people.ts";
import type { Asset } from "../types.ts";
import { peopleConfirmedByNote, peoplePendingNote } from "../view-copy.ts";
import { EnrichmentConsent } from "./EnrichmentConsent.tsx";
import type { EnrichmentConsentProps } from "./EnrichmentConsent.tsx";

import styles from "./People.module.css";

/** The photograph a person's card crops: the first of theirs this device has
 *  actually loaded. `undefined` where none is loaded — the card keeps its
 *  square and says nothing it cannot show. */
export function coverFor(
  person: Person,
  assets: readonly Asset[]
): Asset | undefined {
  const wanted = new Set(person.asset_ids);
  return assets.find((asset) => wanted.has(asset.asset_id));
}

/** `faceCropStyle` returns pixel geometry for a fixed `boxPx` square. Calling
 *  it with `boxPx = 100` turns every output into a PERCENTAGE of whatever
 *  container the caller actually lays out at — the scale factor cancels, so
 *  the same numbers are correct at 60px or 600px. That is what makes a face
 *  crop possible inside this shelf's fluid, six/three-column grid without
 *  measuring the rendered box in JS. */
const CROP_BOX_UNIT = 100;

function ProposalCard({
  proposal,
  onNameProposal,
}: {
  proposal: FaceProposal;
  onNameProposal: (regionId: string) => void;
}) {
  const cover = proposal.cover;
  const src = cover?.content_uri ?? cover?.thumb_uri ?? null;
  const crop = src
    ? faceCropStyle(cover?.bbox, cover?.width, cover?.height, CROP_BOX_UNIT)
    : null;
  return (
    <button
      type="button"
      className={styles.card}
      onClick={() => onNameProposal(proposal.region_id)}
    >
      <span className={`${styles.crop} ${styles.proposalCrop}`}>
        {src ? (
          crop ? (
            <img
              className={styles.cropImg}
              src={src}
              alt=""
              style={{
                width: `${crop.width}%`,
                height: `${crop.height}%`,
                left: `${crop.left}%`,
                top: `${crop.top}%`,
                position: "absolute",
              }}
            />
          ) : (
            // No bbox/dimensions to crop by honestly — the plain source
            // photograph, same fallback FaceReview's own FaceTiles takes,
            // never a guessed position.
            <img className={styles.cropImg} src={src} alt="" />
          )
        ) : null}
      </span>
      {/* Never a name — see file header. A proposal is evidence, not an
          identity, however many photographs share its candidate. */}
      <span className={styles.proposalLabel}>Not yet named</span>
      <span className={styles.count}>{proposal.count}</span>
    </button>
  );
}

export function PeopleShelf({
  people,
  proposals,
  unmatchedCount,
  assets,
  onOpen,
  onReview,
  onNameProposal,
  gate,
}: {
  people: readonly Person[];
  /** Unconfirmed face proposals, grouped and never named — see
   *  `queries/people.ts`'s header. Optional so a caller mid-migration to the
   *  extended `people` query can still render the confirmed-only roster. */
  proposals?: readonly FaceProposal[];
  /** The vault-wide unmatched face count, from the SAME `people` read this
   *  shelf's roster came from (`queries/people.ts`) — `null`/`undefined`
   *  while unread, so the pending note omits the number rather than
   *  claiming a zero nobody checked. */
  unmatchedCount?: number | null;
  /** What is loaded, for the covers. */
  assets: readonly Asset[];
  onOpen: (partyId: string) => void;
  /** Opens the one-at-a-time review queue (§8). The pending note is the way
   *  in — review is a mode of this shelf, not a ninth tab. */
  onReview?: () => void;
  /** Opens the review queue focused on one proposal's own region — a
   *  proposal card's route to naming it, the same queue `onReview` opens,
   *  just already on the face the member tapped. */
  onNameProposal?: (regionId: string) => void;
  /** The consent gate's props (#712), present only while the roster
   *  is empty and the question has not been answered this session — see the
   *  file header. Renders IN PLACE of the grid/note. */
  gate?: EnrichmentConsentProps;
}) {
  if (gate) {
    return (
      <div className={styles.shelf}>
        <EnrichmentConsent {...gate} />
      </div>
    );
  }
  const note = peoplePendingNote(unmatchedCount ?? null);
  return (
    <div className={styles.shelf}>
      <div className={styles.grid}>
        {people.map((person) => {
          const cover = coverFor(person, assets);
          // Only when the group actually spans more than one answerer — see
          // `peopleConfirmedByNote`. Null on every ordinary card, so nothing
          // is added to the common case's geometry.
          const confirmedBy = peopleConfirmedByNote(person.confirmed_by ?? []);
          // NOT a fallback string. `queries/people.ts` only ever names a
          // party already in `core.party` with `kind = 'person'`, and the
          // one command that can mint one (`people.create`,
          // packages/vault/src/commands/people.ts) requires
          // `display_name` (`minLength: 1`) — there is no path that confirms
          // a face onto a person with no name, so `person.name` is never
          // actually null here.
          return (
            <button
              key={person.party_id}
              type="button"
              className={styles.card}
              onClick={() => onOpen(person.party_id)}
            >
              <span
                className={styles.crop}
                aria-hidden="true"
                // `mountMediaInto` stamps the scope itself and paints exactly
                // once per element (media.ts), so the crop needs no state of
                // its own — and a card with no loaded cover paints nothing
                // over its square rather than a broken image.
                ref={(el) => {
                  if (cover) mountMedia(el, cover);
                }}
              />
              <span className={styles.name}>{person.name}</span>
              <span className={styles.count}>{person.count}</span>
              {confirmedBy ? (
                <span className={styles.confirmedBy}>{confirmedBy}</span>
              ) : null}
            </button>
          );
        })}
        {onNameProposal
          ? (proposals ?? []).map((proposal) => (
              <ProposalCard
                key={proposal.cluster_id}
                proposal={proposal}
                onNameProposal={onNameProposal}
              />
            ))
          : null}
      </div>
      {onReview ? (
        // The note is the way into the queue — a labelled control, not a
        // bare paragraph next to an unexplained button.
        <button type="button" className={styles.noteButton} onClick={onReview}>
          {note}
        </button>
      ) : (
        <p className={styles.note}>{note}</p>
      )}
    </div>
  );
}
