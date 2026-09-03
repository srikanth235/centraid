import { faceCropStyle } from "../../_shared/face-crop.ts";
import { mountMedia } from "../media.ts";
import type { FaceProposal, Person } from "../people.ts";
import type { Asset } from "../types.ts";
import { peopleConfirmedByNote, peoplePendingNote } from "../view-copy.ts";
import { EnrichmentConsent } from "./EnrichmentConsent.tsx";
import type { EnrichmentConsentProps } from "./EnrichmentConsent.tsx";

import styles from "./People.module.css";

export function coverFor(
  person: Person,
  assets: readonly Asset[]
): Asset | undefined {
  const wanted = new Set(person.asset_ids);
  return assets.find((asset) => wanted.has(asset.asset_id));
}

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
            <img className={styles.cropImg} src={src} alt="" />
          )
        ) : null}
      </span>
      {/* Never a name: a proposal is evidence, not an identity. */}
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
  proposals?: readonly FaceProposal[];
  unmatchedCount?: number | null;
  assets: readonly Asset[];
  onOpen: (partyId: string) => void;
  onReview?: () => void;
  onNameProposal?: (regionId: string) => void;
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
          const confirmedBy = peopleConfirmedByNote(person.confirmed_by ?? []);
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
        <button type="button" className={styles.noteButton} onClick={onReview}>
          {note}
        </button>
      ) : (
        <p className={styles.note}>{note}</p>
      )}
    </div>
  );
}
