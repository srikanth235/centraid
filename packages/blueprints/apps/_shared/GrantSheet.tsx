/**
 * THE GRANT SHEET, web seat (#825).
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

import { NOBODY_TO_SHARE_WITH } from "./grant-audiences.ts";
import {
  alreadyGrantedOutcome,
  audienceNotKnown,
  capabilityLabel,
  capabilityUnchangedOutcome,
  deliveryLabel,
  GRANT_SHEET_TITLE,
  GRANTS_UNREADABLE,
  grantedOutcome,
  groupContributionNote,
  nothingSharedYet,
  reachLabel,
  reachNote,
  REGISTRY_UNREADABLE,
  REVOKE_CANCEL_ACTION,
  REVOKE_CONFIRM_ACTION,
  revokeConfirmBody,
  revokeConfirmTitle,
  subjectNotOfferable,
} from "./grant-copy.ts";
import type { GrantDoor, SubjectRegistry } from "./grant-door.ts";
import { webGrantDoor } from "./grant-gateway.ts";
import {
  capabilitiesFor,
  channelReach,
  defaultCapability,
  drawableCapability,
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
  return subject.label?.trim()
    ? subject.label.trim()
    : subjectNoun(subject.subjectType);
}

export function GrantSheet(props: GrantSheetProps): JSX.Element | null {
  // Built ONCE per mount: the door is an effect dependency, and a fresh object
  // every render would re-read the grant plane on every keystroke.
  const door = useMemo(() => props.door ?? webGrantDoor(), [props.door]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  // `null` is "the registry read has not answered". It is NOT an empty
  // registry: an empty one is the refusal "this cannot be shared", and
  // painting that before the gateway has spoken refuses on its behalf.
  const [registry, setRegistry] = useState<SubjectRegistry | null>(null);
  const [audienceId, setAudienceId] = useState(props.audienceId ?? "");
  const [subjectId, setSubjectId] = useState("");
  // `null` is "the member has not chosen"; the capability is then DERIVED from
  // whatever grant already stands, during render rather than in an effect.
  const [picked, setPicked] = useState<GrantCapability | null>(null);
  const [standing, setStanding] = useState<GrantRecord[] | null>(null);
  // `undefined` until a read answers — see `GrantChannel`. Starting at `null`
  // would paint "Not reached yet" over every person for one frame.
  const [channel, setChannel] = useState<GrantChannel>(undefined);
  const [audienceKnown, setAudienceKnown] = useState(true);
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
  // Effect KEYS, not objects: a host that rebuilds its roster array on every
  // render must not make the sheet re-read the grant plane on every render, so
  // the reads below close over these primitives and nothing else.
  const audienceKey = audience?.id ?? "";
  const audienceKind = audience?.kind ?? "party";
  const pinnedType = props.subject?.subjectType ?? "";
  const pinnedId = props.subject?.subjectId ?? "";

  // Opening resets the sheet and reads the declared registry. Every write to
  // state is deferred off the effect body — a synchronous setState here would
  // cascade a second render before the first one has painted.
  useEffect(() => {
    if (!props.open) return;
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setBusy(false);
      setRefusal(null);
      setConfirming(null);
      setPicked(null);
      setAudienceId(props.audienceId ?? "");
      setSubjectId("");
      setRegistry(null);
      const read = await door.subjects();
      if (active) setRegistry(read);
    });
    return () => {
      active = false;
    };
  }, [props.open, props.audienceId, door]);

  // The standing read follows whichever question the sheet was opened with:
  // the object side when a subject is pinned, the person side otherwise.
  //
  // REACH IS A FACT ABOUT THE PERSON, not about which door was used. An
  // object-first sheet still names someone, so it still owes an honest reach
  // line — and its own read, since `forSubject` cannot answer one.
  useEffect(() => {
    if (!props.open) return;
    if (!pinnedType && !audienceKey) return;
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setStanding(null);
      setChannel(undefined);
      setAudienceKnown(true);
      // A reach read that fails leaves the channel UNKNOWN and the standing
      // list alone: "we could not ask" is not "never reached", and it is not
      // a reason to blank the shares the other read answered.
      const readReach = async (): Promise<void> => {
        try {
          const reach = await door.forParty(audienceKey);
          if (!active) return;
          if (reach.known) setChannel(reach.channel);
          else setAudienceKnown(false);
        } catch {
          /* unknown draws the checking line, never a claim */
        }
      };
      try {
        if (pinnedType) {
          const [found] = await Promise.all([
            door.forSubject({ subjectType: pinnedType, subjectId: pinnedId }),
            audienceKind === "party" && audienceKey
              ? readReach()
              : Promise.resolve(),
          ]);
          if (active) setStanding(found);
          return;
        }
        if (audienceKind === "party") {
          const reach = await door.forParty(audienceKey);
          if (!active) return;
          setChannel(reach.channel);
          setAudienceKnown(reach.known);
          setStanding(reach.grants);
          return;
        }
        const read = await door.forAudience(audienceKind, audienceKey);
        if (!active) return;
        setAudienceKnown(read.known);
        setStanding(read.grants);
      } catch {
        if (!active) return;
        setStanding([]);
        setRefusal(GRANTS_UNREADABLE);
      }
    });
    return () => {
      active = false;
    };
  }, [props.open, pinnedType, pinnedId, audienceKind, audienceKey, door]);

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
  // Derived at render — an effect writing it back would be a second source of
  // truth for a value the standing read already answers.
  const alreadyStanding =
    subject && standing
      ? grantOverSubject(
          standing,
          subject,
          audience ? { kind: audience.kind, id: audience.id } : undefined
        )
      : undefined;

  if (!props.open) return null;

  const capabilities = subject
    ? capabilitiesFor(registry?.offers ?? [], subject.subjectType)
    : [];
  // Clamped to what the picker could draw: a standing `edit` over a subject
  // the registry has since narrowed must not be what Share posts.
  const capability = drawableCapability(
    capabilities,
    picked ?? defaultCapability(alreadyStanding)
  );
  const noun = subject ? subjectNoun(subject.subjectType) : "shared item";
  // Three states, not two: the registry has not answered, it answered nothing
  // for this subject, or it could not be read. Only the middle one is the
  // refusal, and only it may say a subject cannot be shared.
  const registryPending = registry === null;
  const registryUnreadable = registry !== null && !registry.readable;
  const notOfferable =
    Boolean(subject) &&
    registry !== null &&
    registry.readable &&
    capabilities.length === 0;
  const contributionNote = subject
    ? groupContributionNote(subject.subjectType, capability)
    : null;
  const rows = standing ? liveGrants(standing) : [];
  // An audience the vault has no record of gets its OWN sentence: "nothing is
  // shared with them" is a lie about a person we do not know.
  const standingEmptyLine = audienceKnown
    ? nothingSharedYet(
        props.subject
          ? subjectTitle(props.subject)
          : (audience?.label ?? "this audience")
      )
    : audienceNotKnown(audience?.label ?? "this audience");
  const showStanding = audienceKnown && rows.length > 0;
  const reach = channelReach(channel);
  const cannotShare =
    !audience ||
    !subject ||
    registryPending ||
    registryUnreadable ||
    notOfferable ||
    busy;

  const submit = async (): Promise<void> => {
    if (!audience || !subject || cannotShare) return;
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
      outcome.outcome === "exists_other_capability"
        ? capabilityUnchangedOutcome(audience.label, outcome.standing)
        : outcome.outcome === "exists"
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
      <h2>
        {revokeConfirmTitle(audienceLabelFor(confirming, props.audiences))}
      </h2>
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
                {/* AN EMPTY PICKER IS NOT AN ANSWER (#825). A host that opens
                    the sheet over a roster it read as empty says so in words;
                    a host that could not read the roster at all never gets
                    here — it speaks its own sentence and does not open. */}
                {props.audiences.length === 0 ? (
                  <p className={styles.note}>{NOBODY_TO_SHARE_WITH}</p>
                ) : (
                  <select
                    aria-label="Person or circle"
                    value={audience?.id ?? ""}
                    onChange={(event) => {
                      setPicked(null);
                      setAudienceId(event.target.value);
                    }}
                  >
                    {props.audiences.map((option) => (
                      <option
                        key={`${option.kind}:${option.id}`}
                        value={option.id}
                      >
                        {option.kind === "circle"
                          ? `Named group · ${option.label}`
                          : option.label}
                      </option>
                    ))}
                  </select>
                )}
                {/* An unknown reach draws the checking line and nothing else:
                    every other label is a claim about this person that only an
                    answered read may make. */}
                {audience?.kind === "party" && audienceKnown ? (
                  <p className={styles.reach}>
                    <span className={styles.reachState} data-reach={reach}>
                      {reachLabel(reach)}
                    </span>
                    <span className={styles.note}>{reachNote(reach)}</span>
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
                    onChange={(event) => {
                      // A different subject may answer different verbs, so the
                      // member's pick does not carry across.
                      setPicked(null);
                      setSubjectId(event.target.value);
                    }}
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

              {/* The fieldset carries the group's accessible name; the
                  section would only repeat it. */}
              <section className={styles.step}>
                <p className={styles.eyebrow}>Access</p>
                <fieldset className="kit-seg" aria-label="Access">
                  {capabilities.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      aria-pressed={capability === candidate}
                      onClick={() => setPicked(candidate)}
                    >
                      {capabilityLabel(candidate)}
                    </button>
                  ))}
                </fieldset>
                {contributionNote ? (
                  <p className={styles.note}>{contributionNote}</p>
                ) : null}
                {notOfferable ? (
                  <p className={styles.refusal}>{subjectNotOfferable(noun)}</p>
                ) : null}
                {registryUnreadable ? (
                  <p className={styles.refusal}>{REGISTRY_UNREADABLE}</p>
                ) : null}
              </section>

              <section className={styles.step} aria-label="Already shared">
                <p className={styles.eyebrow}>Already shared</p>
                {standing === null ? (
                  <p className={styles.note}>Reading shares…</p>
                ) : showStanding ? (
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
                ) : (
                  <p className={styles.note}>{standingEmptyLine}</p>
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
                disabled={cannotShare}
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
