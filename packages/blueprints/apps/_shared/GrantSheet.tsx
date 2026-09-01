/**
 * Grant sheet, web seat (#825). Audience-first (G-audience): person → what
 * → capability. Object-first is an ENTRY via `subject`, not a second sheet.
 * `edit` only where the subject registry answers it. Feedback is `onStatus`,
 * never a toast.
 */

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import { NOBODY_TO_SHARE_WITH } from "./grant-audiences.ts";
import {
  accessChangedOutcome,
  alreadyGrantedOutcome,
  audienceNotKnown,
  CHANGE_ACCESS_ACTION,
  CHANGE_ACCESS_CANCEL_ACTION,
  capabilityLabel,
  changeAccessConfirmBody,
  changeAccessConfirmTitle,
  GRANT_SHEET_TITLE,
  GRANTS_UNREACHABLE,
  GRANTS_UNREADABLE,
  grantStandingLabel,
  grantedOutcome,
  groupContributionNote,
  nothingSharedYet,
  notSharedWithAnyoneYet,
  reachLabel,
  reachNote,
  REGISTRY_UNREACHABLE,
  REGISTRY_UNREADABLE,
  REVOKE_CANCEL_ACTION,
  REVOKE_CONFIRM_ACTION,
  revokeConfirmBody,
  revokeConfirmTitle,
  subjectNotOfferable,
} from "./grant-copy.ts";
import { isGrantUnreachable } from "./grant-door.ts";
import type { GrantDoor, SubjectRegistry } from "./grant-door.ts";
import { webGrantDoor } from "./grant-gateway.ts";
import {
  capabilitiesFor,
  channelReach,
  defaultCapability,
  drawableCapability,
  grantOverSubject,
  grantRequestFor,
  liveGrants,
  reachBlocksSharing,
  subjectNoun,
} from "./grant-plane.ts";
import type {
  GrantAudienceOption,
  GrantCapability,
  GrantChannel,
  GrantRecord,
  GrantSubject,
} from "./grant-plane.ts";
import { KitModal } from "./KitModal.tsx";
import { Segmented } from "./Segmented.tsx";

import styles from "./GrantSheet.module.css";

export interface GrantSheetProps {
  open: boolean;
  onClose: () => void;
  audiences: readonly GrantAudienceOption[];
  subjects?: readonly GrantSubject[];
  subject?: GrantSubject;
  audienceId?: string;
  onStatus: (message: string) => void;
  door?: GrantDoor;
}

function subjectKey(subject: GrantSubject): string {
  return `${subject.subjectType}:${subject.subjectId}`;
}

function subjectTitle(subject: GrantSubject): string {
  return subject.label?.trim()
    ? subject.label.trim()
    : subjectNoun(subject.subjectType);
}

export function GrantSheet(props: GrantSheetProps): JSX.Element | null {
  // Once per mount: a fresh door every render would re-read on every keystroke.
  const door = useMemo(() => props.door ?? webGrantDoor(), [props.door]);
  // `null` = unread. Empty registry is "cannot be shared" — do not paint that early.
  const [registry, setRegistry] = useState<SubjectRegistry | null>(null);
  const [audienceId, setAudienceId] = useState(props.audienceId ?? "");
  const [subjectId, setSubjectId] = useState("");
  // `null` = unchosen.
  const [picked, setPicked] = useState<GrantCapability | null>(null);
  const [standing, setStanding] = useState<GrantRecord[] | null>(null);
  // `undefined` until a read answers. `null` would paint "Not reached yet" for one frame.
  const [channel, setChannel] = useState<GrantChannel>(undefined);
  const [audienceKnown, setAudienceKnown] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<GrantRecord | null>(null);
  const [changeConfirm, setChangeConfirm] = useState(false);

  const audience =
    props.audiences.find((option) => option.id === audienceId) ??
    props.audiences[0];
  const offered = props.subject ? [props.subject] : (props.subjects ?? []);
  const subject =
    offered.find((candidate) => subjectKey(candidate) === subjectId) ??
    offered[0];
  // Effect keys, not objects — a rebuilt roster array must not re-read every render.
  const audienceKey = audience?.id ?? "";
  const audienceKind = audience?.kind ?? "party";
  const pinnedType = props.subject?.subjectType ?? "";
  const pinnedId = props.subject?.subjectId ?? "";

  // Reset + registry read deferred off the effect body — sync setState would cascade.
  useEffect(() => {
    if (!props.open) return;
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setBusy(false);
      setRefusal(null);
      setConfirming(null);
      setChangeConfirm(false);
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

  // Reach is about the person: object-first still owes a reach read.
  useEffect(() => {
    if (!props.open) return;
    if (!pinnedType && !audienceKey) return;
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setStanding(null);
      setChannel(undefined);
      setAudienceKnown(true);
      // Failed reach leaves channel unknown; do not blank the standing list.
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
      } catch (error) {
        if (!active) return;
        setStanding([]);
        setRefusal(
          isGrantUnreachable(error) ? GRANTS_UNREACHABLE : GRANTS_UNREADABLE
        );
      }
    });
    return () => {
      active = false;
    };
  }, [props.open, pinnedType, pinnedId, audienceKind, audienceKey, door]);

  // Open on the standing capability — do not propose a downgrade or a widen.
  // An effect writing it back would be a second source of truth.
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
  // Clamp to drawable: a standing `edit` the registry narrowed must not be posted.
  const capability = drawableCapability(
    capabilities,
    picked ?? defaultCapability(alreadyStanding)
  );
  const noun = subject ? subjectNoun(subject.subjectType) : "shared item";
  // Unread, empty-for-subject, refused, unreachable. Only the second refuses.
  const registryPending = registry === null;
  const registryProblem =
    registry !== null && !registry.readable
      ? registry.reach === "unreachable"
        ? REGISTRY_UNREACHABLE
        : REGISTRY_UNREADABLE
      : null;
  const registryUnreadable = registryProblem !== null;
  const notOfferable =
    Boolean(subject) &&
    registry !== null &&
    registry.readable &&
    capabilities.length === 0;
  const contributionNote = subject
    ? groupContributionNote(subject.subjectType, capability)
    : null;
  const rows = standing ? liveGrants(standing) : [];
  // Unknown audience gets its own sentence — "nothing shared" is a lie.
  // Subject-first lists this subject's grants; audience-first, the audience's.
  const standingEmptyLine = audienceKnown
    ? props.subject
      ? notSharedWithAnyoneYet(subjectTitle(props.subject))
      : nothingSharedYet(audience?.label ?? "this audience")
    : audienceNotKnown(audience?.label ?? "this audience");
  const showStanding = audienceKnown && rows.length > 0;
  const reach = channelReach(channel);
  // The standing answer this submit would replace. Same verb is not a change:
  // the route reads that back.
  const changing =
    alreadyStanding && alreadyStanding.capability !== capability
      ? alreadyStanding
      : undefined;
  const cannotShare =
    !audience ||
    !subject ||
    registryPending ||
    registryUnreadable ||
    notOfferable ||
    // A person is reachable only through a live link (#903), and the command
    // pack refuses the rest — so the sheet does not grow a control naming an
    // act it cannot perform. The reach line above already says why.
    reachBlocksSharing(reach) ||
    busy;

  const submit = async (): Promise<void> => {
    if (!audience || !subject || cannotShare) return;
    // No in-place change of verb (ruling V-table): posting it would be refused.
    // Ask first — the change costs the audience their copy while it runs.
    if (changing) {
      setChangeConfirm(true);
      return;
    }
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
    // A held share (#883) reads "on its way", never as the granted outcome: no
    // vault has been asked about it yet.
    props.onStatus(
      outcome.outcome === "awaiting_confirmation" ||
        outcome.outcome === "queued"
        ? outcome.message
        : outcome.outcome === "exists"
          ? alreadyGrantedOutcome(audience.label)
          : grantedOutcome(audience.label, capability)
    );
    props.onClose();
  };

  const changeAccess = async (): Promise<void> => {
    if (!audience || !subject || !changing) return;
    setBusy(true);
    setRefusal(null);
    const outcome = await door.changeCapability(
      changing.grantId,
      grantRequestFor(audience, subject, capability)
    );
    setBusy(false);
    setChangeConfirm(false);
    if (!outcome.ok) {
      setRefusal(outcome.message);
      return;
    }
    props.onStatus(
      outcome.outcome === "awaiting_confirmation" ||
        outcome.outcome === "queued"
        ? outcome.message
        : accessChangedOutcome(audience.label, capability)
    );
    props.onClose();
  };

  const revoke = async (grant: GrantRecord): Promise<void> => {
    setBusy(true);
    const outcome = await door.revoke(grant.grantId);
    setBusy(false);
    setConfirming(null);
    // Route sentence, verbatim — nothing here may soften it.
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
  ) : changeConfirm && changing && audience ? (
    <div className={styles.confirm}>
      <h2>{changeAccessConfirmTitle(audience.label, capability)}</h2>
      <p className={styles.confirmBody}>
        {changeAccessConfirmBody(subjectNoun(changing.subjectType))}
      </p>
      <div className="kit-modal-foot">
        <button
          type="button"
          className="kit-btn"
          onClick={() => setChangeConfirm(false)}
        >
          {CHANGE_ACCESS_CANCEL_ACTION}
        </button>
        <button
          type="button"
          className="kit-btn primary"
          disabled={busy}
          onClick={() => void changeAccess()}
        >
          {CHANGE_ACCESS_ACTION}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <KitModal
      layer="top"
      open={props.open}
      className="kit-modal-back"
      label={GRANT_SHEET_TITLE}
      ariaModal
      onDismiss={props.onClose}
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
                {/* Empty picker is not an answer (#825). Unreadable roster never opens here. */}
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
                {/* Unknown reach: checking line only — other labels are claims. */}
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
                      // Different subject, different verbs — pick does not carry.
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

              {/* Fieldset carries the group's accessible name; the section would repeat it. */}
              <section className={styles.step}>
                <p className={styles.eyebrow}>Access</p>
                <Segmented
                  label="Access"
                  options={capabilities.map((candidate) => ({
                    key: candidate,
                    label: capabilityLabel(candidate),
                    pressed: capability === candidate,
                    select: () => setPicked(candidate),
                  }))}
                />
                {contributionNote ? (
                  <p className={styles.note}>{contributionNote}</p>
                ) : null}
                {notOfferable ? (
                  <p className={styles.refusal}>{subjectNotOfferable(noun)}</p>
                ) : null}
                {registryProblem ? (
                  <p className={styles.refusal}>{registryProblem}</p>
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
                          {/* The vault's own phrase and its own reason, both
                              verbatim (ruling V-phrases). An unanswered wire
                              prints the capability alone. */}
                          <span
                            className={styles.standingMeta}
                            data-phrase={grant.phrase ?? "unstated"}
                          >
                            {capabilityLabel(grant.capability)}
                            {grantStandingLabel(grant)
                              ? ` · ${grantStandingLabel(grant)}`
                              : ""}
                          </span>
                          {grant.reason ? (
                            <span className={styles.note}>{grant.reason}</span>
                          ) : null}
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
                {busy
                  ? "Sharing…"
                  : changing
                    ? CHANGE_ACCESS_ACTION
                    : GRANT_SHEET_TITLE}
              </button>
            </div>
          </>
        )}
      </div>
    </KitModal>
  );
}

/** Roster label, or kind — an id is not a name. */
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
