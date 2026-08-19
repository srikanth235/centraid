/**
 * THE GRANT SHEET, web seat (issue #825).
 *
 * One sheet, two doors into it, one core:
 *
 *  - AUDIENCE-FIRST is primary (ruling G-audience). Person → what → capability,
 *    in that order, because "who can see this" is the question a member is
 *    actually holding. The standing list under it is `?partyId=` — everything
 *    that person can reach — so the sheet answers the question it asked.
 *  - OBJECT-FIRST passes `subject` and reuses every line of the above; the
 *    "what" step becomes a fixed line and the standing list becomes the object
 *    side (`?subjectType=&subjectId=`). It is an ENTRY, not a second sheet.
 *
 * The capability picker never guesses. `edit` is drawn only where the declared
 * subject registry the gateway serves answers it — a member is not offered a
 * verb the vault has no strategy for and would refuse at the door.
 *
 * Feedback is the frame's one status line (`onStatus`), never a toast. The
 * only strings the sheet paints in place are the ones a member cannot act on
 * anywhere else: a subject refusal, and the destructive confirm.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import {
  alreadyGrantedOutcome,
  capabilityLabel,
  deliveryLabel,
  GRANT_SHEET_TITLE,
  GRANTS_UNREADABLE,
  grantedOutcome,
  groupContributionNote,
  nothingSharedYet,
  reachLabel,
  reachNote,
  REVOKE_CANCEL_ACTION,
  REVOKE_CONFIRM_ACTION,
  revokeConfirmBody,
  revokeConfirmTitle,
  subjectNotOfferable,
} from "./grant-copy.ts";
import type { GrantDoor } from "./grant-door.ts";
import { webGrantDoor } from "./grant-gateway.ts";
import {
  capabilitiesFor,
  channelReach,
  defaultCapability,
  grantDelivery,
  grantOverSubject,
  grantRequestFor,
  liveGrants,
  subjectNoun,
} from "./grant-plane.ts";
import type {
  GrantAudienceOption,
  GrantCapability,
  GrantChannel,
  GrantRecord,
  GrantSubject,
  GrantSubjectOffer,
} from "./grant-plane.ts";

import styles from "./GrantSheet.module.css";

export interface GrantSheetProps {
  open: boolean;
  onClose: () => void;
  /** People and named circles this sheet may name. Ordered by the host. */
  audiences: readonly GrantAudienceOption[];
  /** Everything the host can offer to share. Ignored when `subject` is set. */
  subjects?: readonly GrantSubject[];
  /** OBJECT-FIRST entry: the one subject this sheet was opened over. */
  subject?: GrantSubject;
  /** Preselect an audience — a person screen opening the sheet on them. */
  audienceId?: string;
  /** The frame's one status line. Every outcome is reported here. */
  onStatus: (message: string) => void;
  /** The grant plane. Defaults to this seat's bridge door. */
  door?: GrantDoor;
}

function subjectKey(subject: GrantSubject): string {
  return `${subject.subjectType}:${subject.subjectId}`;
}

/** The title a member reads for a subject: its own, else its noun. */
function subjectTitle(subject: GrantSubject): string {
  return subject.label?.trim() ? subject.label.trim() : subjectNoun(subject.subjectType);
}

export function GrantSheet(props: GrantSheetProps): JSX.Element | null {
  // Built ONCE per mount: the door is an effect dependency, and a fresh object
  // every render would re-read the grant plane on every keystroke.
  const door = useMemo(() => props.door ?? webGrantDoor(), [props.door]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [offers, setOffers] = useState<GrantSubjectOffer[]>([]);
  const [audienceId, setAudienceId] = useState(props.audienceId ?? "");
  const [subjectId, setSubjectId] = useState("");
  const [capability, setCapability] = useState<GrantCapability>("view");
  const [standing, setStanding] = useState<GrantRecord[] | null>(null);
  const [channel, setChannel] = useState<GrantChannel>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<GrantRecord | null>(null);

  const audience =
    props.audiences.find((option) => option.id === audienceId) ??
    props.audiences[0];
  const offered = props.subject ? [props.subject] : (props.subjects ?? []);
  const subject =
    offered.find((candidate) => subjectKey(candidate) === subjectId) ??
    offered[0];
  // Effect keys, not objects: a host that rebuilds its roster array on every
  // render must not make the sheet re-read the grant plane on every render.
  const audienceKey = audience?.id ?? "";
  const audienceKind = audience?.kind ?? "party";
  const subjectPin = props.subject ? subjectKey(props.subject) : "";

  useEffect(() => {
    if (!props.open) return;
    setBusy(false);
    setRefusal(null);
    setConfirming(null);
    setAudienceId(props.audienceId ?? "");
    setSubjectId("");
    let active = true;
    void door.subjects().then((rows) => {
      if (active) setOffers(rows);
    });
    return () => {
      active = false;
    };
  }, [props.open, props.audienceId, door]);

  // The standing read follows whichever question the sheet was opened with:
  // the object side when a subject is pinned, the person side otherwise.
  useEffect(() => {
    if (!props.open) return;
    const pinned = props.subject;
    if (!pinned && !audience) return;
    let active = true;
    setStanding(null);
    void (async () => {
      try {
        if (pinned) {
          const rows = await door.forSubject(pinned);
          if (active) setStanding(rows);
          return;
        }
        if (audience?.kind === "party") {
          const reach = await door.forParty(audience.id);
          if (!active) return;
          setChannel(reach.channel);
          setStanding(reach.grants);
          return;
        }
        if (!audience) return;
        const read = await door.forAudience(audience.kind, audience.id);
        if (!active) return;
        setChannel(null);
        setStanding(read.grants);
      } catch {
        if (active) {
          setStanding([]);
          setRefusal(GRANTS_UNREADABLE);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [props.open, subjectPin, audienceKind, audienceKey, door]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !props.open) return;
    dialog.showModal?.();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [props.open]);

  // A grant already standing over this exact pair opens on ITS capability:
  // proposing `view` over a live `edit` would read as a downgrade nobody asked
  // for, and proposing `edit` because the registry allows it widens the grant.
  const alreadyStanding =
    subject && standing ? grantOverSubject(standing, subject) : undefined;
  useEffect(() => {
    setCapability(defaultCapability(alreadyStanding));
  }, [alreadyStanding]);

  if (!props.open) return null;

  const capabilities = subject
    ? capabilitiesFor(offers, subject.subjectType)
    : [];
  const noun = subject ? subjectNoun(subject.subjectType) : "shared item";
  const notOfferable = Boolean(subject) && capabilities.length === 0;
  const contributionNote = subject
    ? groupContributionNote(subject.subjectType, capability)
    : null;
  const rows = standing ? liveGrants(standing) : [];

  const submit = async (): Promise<void> => {
    if (!audience || !subject || notOfferable || busy) return;
    setBusy(true);
    setRefusal(null);
    const outcome = await door.create(
      grantRequestFor(audience, subject, capability)
    );
    setBusy(false);
    if (!outcome.ok) {
      setRefusal(outcome.message);
      return;
    }
    props.onStatus(
      outcome.outcome === "exists"
        ? alreadyGrantedOutcome(audience.label)
        : grantedOutcome(audience.label, capability)
    );
    props.onClose();
  };

  const revoke = async (grant: GrantRecord): Promise<void> => {
    setBusy(true);
    const outcome = await door.revoke(grant.grantId);
    setBusy(false);
    setConfirming(null);
    // The route's sentence, verbatim: it is derived from what each delivered
    // copy actually did, and nothing here may soften it.
    props.onStatus(outcome.message);
    if (outcome.ok)
      setStanding((current) =>
        (current ?? []).filter((row) => row.grantId !== grant.grantId)
      );
  };

  const confirmView = confirming ? (
    <div className={styles.confirm}>
      <h2>{revokeConfirmTitle(audienceLabelFor(confirming, props.audiences))}</h2>
      <p className={styles.confirmBody}>
        {revokeConfirmBody(
          audienceLabelFor(confirming, props.audiences),
          subjectNoun(confirming.subjectType)
        )}
      </p>
      <div className="kit-modal-foot">
        <button
          type="button"
          className="kit-btn"
          onClick={() => setConfirming(null)}
        >
          {REVOKE_CANCEL_ACTION}
        </button>
        <button
          type="button"
          className="kit-btn destructive"
          disabled={busy}
          onClick={() => void revoke(confirming)}
        >
          {REVOKE_CONFIRM_ACTION}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <dialog
      ref={dialogRef}
      className="kit-modal-back"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <button
        type="button"
        className="kit-modal-scrim"
        aria-label="Close"
        onClick={props.onClose}
      />
      <div className="kit-modal" style={{ maxWidth: "440px" }}>
        {confirmView ?? (
          <>
            <h2>{GRANT_SHEET_TITLE}</h2>
            <div className={styles.steps}>
              <section className={styles.step} aria-label="Person">
                <p className={styles.eyebrow}>Person</p>
                <select
                  aria-label="Person or circle"
                  value={audience?.id ?? ""}
                  onChange={(event) => setAudienceId(event.target.value)}
                >
                  {props.audiences.map((option) => (
                    <option key={`${option.kind}:${option.id}`} value={option.id}>
                      {option.kind === "circle"
                        ? `Named group · ${option.label}`
                        : option.label}
                    </option>
                  ))}
                </select>
                {audience?.kind === "party" ? (
                  <p className={styles.reach}>
                    <span
                      className={styles.reachState}
                      data-reach={channelReach(channel)}
                    >
                      {reachLabel(channelReach(channel))}
                    </span>
                    <span className={styles.note}>
                      {reachNote(channelReach(channel))}
                    </span>
                  </p>
                ) : null}
              </section>

              <section className={styles.step} aria-label="What">
                <p className={styles.eyebrow}>What</p>
                {props.subject ? (
                  <p className={styles.fixedSubject}>
                    {subjectTitle(props.subject)}
                  </p>
                ) : (
                  <select
                    aria-label="What to share"
                    value={subject ? subjectKey(subject) : ""}
                    onChange={(event) => setSubjectId(event.target.value)}
                  >
                    {offered.map((candidate) => (
                      <option
                        key={subjectKey(candidate)}
                        value={subjectKey(candidate)}
                      >
                        {subjectTitle(candidate)}
                      </option>
                    ))}
                  </select>
                )}
              </section>

              <section className={styles.step} aria-label="Access">
                <p className={styles.eyebrow}>Access</p>
                <div className="kit-seg" role="group" aria-label="Access">
                  {capabilities.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      aria-pressed={capability === candidate}
                      onClick={() => setCapability(candidate)}
                    >
                      {capabilityLabel(candidate)}
                    </button>
                  ))}
                </div>
                {contributionNote ? (
                  <p className={styles.note}>{contributionNote}</p>
                ) : null}
                {notOfferable ? (
                  <p className={styles.refusal}>{subjectNotOfferable(noun)}</p>
                ) : null}
              </section>

              <section className={styles.step} aria-label="Already shared">
                <p className={styles.eyebrow}>Already shared</p>
                {standing === null ? (
                  <p className={styles.note}>Reading shares…</p>
                ) : rows.length === 0 ? (
                  <p className={styles.note}>
                    {nothingSharedYet(
                      props.subject
                        ? subjectTitle(props.subject)
                        : (audience?.label ?? "this audience")
                    )}
                  </p>
                ) : (
                  <ul className={styles.standing}>
                    {rows.map((grant) => (
                      <li className={styles.standingRow} key={grant.grantId}>
                        <span className={styles.standingCopy}>
                          <span className={styles.standingTitle}>
                            {props.subject
                              ? audienceLabelFor(grant, props.audiences)
                              : subjectNoun(grant.subjectType)}
                          </span>
                          <span
                            className={styles.standingMeta}
                            data-delivery={grantDelivery(grant)}
                          >
                            {capabilityLabel(grant.capability)} ·{" "}
                            {deliveryLabel(grantDelivery(grant))}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="kit-btn destructive"
                          disabled={busy}
                          onClick={() => setConfirming(grant)}
                        >
                          {REVOKE_CONFIRM_ACTION}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {refusal ? <p className={styles.refusal}>{refusal}</p> : null}
            </div>

            <div className="kit-modal-foot">
              <button type="button" className="kit-btn" onClick={props.onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="kit-btn primary"
                disabled={!audience || !subject || notOfferable || busy}
                onClick={() => void submit()}
              >
                {busy ? "Sharing…" : GRANT_SHEET_TITLE}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

/**
 * The audience a grant names, in the member's words. A grant carries only the
 * audience id; the host holds the roster, so an id with no roster row answers
 * its kind rather than printing the id — an id is not a name.
 */
function audienceLabelFor(
  grant: GrantRecord,
  audiences: readonly GrantAudienceOption[]
): string {
  const match = audiences.find(
    (option) =>
      option.kind === grant.audience.kind && option.id === grant.audience.id
  );
  if (match) return match.label;
  return grant.audience.kind === "circle" ? "a named group" : "this person";
}
