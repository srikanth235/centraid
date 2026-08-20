// Person (v12 handoff § Screens 4) — one person in full, one level deep.
//
// Hero, two commits, three record sections, and the two acts that end a
// person. Nothing here describes a row, a section head, a chip or a metric:
// they all come from `Shared.tsx` and `shared.module.css`, so this screen and
// the roster cannot disagree about what a 44px line looks like.
//
// THE VAULT LINK IS DRAWN HERE IN FULL, and its section is ABSENT ENTIRELY
// when the sharing plane could not be read: `vaults` and `pending_invites`
// are null together, and an empty `Not linked yet.` over a denied read would
// be this screen answering a question nobody could ask
// (`queries/_shared.ts`).
//
// `Share` AND `Revoke` ARE HERE, AND THEY ARE LIVE (#825). Both were withheld
// while a share could only be a share of a container People does not own; a
// share is now a standing grant over an audience × subject × capability, so
// the person screen is the grant dashboard the ruling names it — every live
// grant reaching this party, with `Revoke` on each row and `Share` on the
// section that lists them (`PersonGrants.tsx`). `Link vault` is gone rather
// than withheld: linking is no longer an act a member performs.
//
// ADDING IS A FIELD WHERE THE ROW WILL BE, never a new screen (handoff
// deviation 3). The composer's state lives in `app-root.tsx`; this screen only
// draws it and reports the four callbacks.
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import {
  cadenceLineLabel,
  isOverdue,
  monthDayLabel,
  whenLabel,
} from "../format.ts";
import {
  EMPTY,
  FIELDS,
  FRAGMENTS,
  LABELS,
  LINK,
  SECTIONS,
  VERBS,
} from "../people-copy.ts";
import type {
  ComposerKey,
  ContactChannel,
  PersonRouteProps,
} from "../types.ts";
import { EmptyState } from "./EmptyState.tsx";
import { PersonGrants } from "./PersonGrants.tsx";
import {
  CadenceLine,
  ChipRow,
  Commits,
  Field,
  PersonAvatar,
  Row,
  Section,
  SkeletonBlock,
  StarButton,
  Verb,
} from "./Shared.tsx";

import shared from "./shared.module.css";

/** The channel kinds the vault stores, offered as the composer's chip row.
 *  The chip's word IS the stored word — the same contract `LOG_KINDS` keeps —
 *  so a kind cannot be labelled one thing here and written as another. */
const CHANNEL_KINDS: readonly ContactChannel["kind"][] = [
  "phone",
  "email",
  "handle",
];

/** `phone · work · preferred` — the channel row's second line. A label the
 *  vault never stored is absent rather than drawn as an empty separator. */
function channelSub(channel: ContactChannel): string {
  const parts: string[] = [channel.kind];
  if (channel.label) parts.push(channel.label);
  if (channel.preferred) parts.push(FRAGMENTS.preferred);
  return parts.join(" · ");
}

export function PersonRoute(props: PersonRouteProps): ReactNode {
  if (props.loading) {
    return (
      <SkeletonBlock>
        <LoadingSkeleton rows={6} />
      </SkeletonBlock>
    );
  }

  // Past the `loading` gate an absent person is a fact, not a pending read
  // (`_shared/view-state-kit.ts`): the id this screen was opened with no longer
  // resolves to a row, so it says so in the shelf's own sentence.
  const person = props.person;
  if (!person) return <EmptyState title={EMPTY.noMatch} />;

  const open = (key: ComposerKey): boolean => !props.collapsed[key];
  const composing = (key: ComposerKey): boolean => props.composer?.key === key;

  /** The composer's own commits, trailing its last field. */
  const commits = (
    <>
      <Verb label={VERBS.save} onClick={props.onComposerSave} />
      <Verb label={VERBS.cancel} quiet onClick={props.onComposerCancel} />
    </>
  );

  /** A section's `Add`, drawn only while its composer is closed — an open
   *  composer already IS the add, and two of them would be two rows. */
  const addVerb = (key: ComposerKey): ReactNode =>
    composing(key) ? null : (
      <Verb label={VERBS.add} onClick={() => props.onOpenComposer(key)} />
    );

  const composer = props.composer;
  const overdue = isOverdue(person);

  // The sharing plane answers all three or none of them, so one flag gates
  // both sections and the hero's ring. `linked` is a fact about the bindings
  // in hand, not a second read.
  const vaults = person.vaults;
  const invites = person.pending_invites;
  const linksAvailable = vaults !== null;
  const linked = (vaults?.length ?? 0) > 0;

  return (
    <section aria-label="Person">
      <div className={shared.hero}>
        <PersonAvatar
          person={person}
          link={linksAvailable ? (linked ? "linked" : "unlinked") : "unknown"}
        />
        <div className={shared.heroText}>
          <div className={shared.heroName}>{displayText(person.name)}</div>
          {person.role ? (
            <div className={shared.heroRole}>{displayText(person.role)}</div>
          ) : null}
        </div>
        <StarButton
          name={person.name}
          starred={person.starred}
          onToggle={props.onToggleStar}
        />
      </div>

      {/* `Every 30 days · last 41 days ago`, in the consequence tone exactly
          while the person is past their cadence. The whole line comes from
          `format.ts`, so it and the roster's meta slot cannot disagree about
          the same person on the same day. */}
      <CadenceLine
        text={cadenceLineLabel(person.cadence_days, person)}
        net={overdue}
      />

      {/* AT MOST ONE FILLED CONTROL PER VIEW: `Log` is the act this screen
          exists for, and `Edit` stands beside it in the outlined recipe. */}
      <Commits narrow={props.narrow}>
        <button type="button" className="kit-btn primary" onClick={props.onLog}>
          {VERBS.log}
        </button>
        <button
          type="button"
          className="kit-btn secondary"
          onClick={props.onEdit}
        >
          {VERBS.edit}
        </button>
      </Commits>

      {/* THE VAULTS SECTION IS ALWAYS OPEN and never collapses: it is the one
          fact this app is built around, and a member should not be able to
          fold it away. It lists the live bindings, then the invitations still
          waiting for an answer — an invitation is not a link, so it keeps its
          own row rather than being counted as one. */}
      {linksAvailable ? (
        <Section
          title={SECTIONS.vaults}
          count={(vaults?.length ?? 0) + (invites?.length ?? 0)}
        >
          {(vaults?.length ?? 0) === 0 && (invites?.length ?? 0) === 0 ? (
            <EmptyState title={EMPTY.vaults} />
          ) : (
            <>
              {(vaults ?? []).map((binding) => (
                <Row
                  key={binding.binding_id}
                  name={LINK.vaultRow}
                  strong
                  sub={LINK.linkedWhen(whenLabel(binding.linked_at))}
                  subNumeric
                />
              ))}
              {(invites ?? []).map((invite) => (
                <Row
                  key={invite.invitation_id}
                  name={LINK.inviteRow}
                  strong
                  sub={invite.container_label ?? LINK.inviteWaiting}
                />
              ))}
            </>
          )}
        </Section>
      ) : null}

      {/* SHARED WITH THEM IS THE GRANT DASHBOARD (`PersonGrants.tsx`): every
          live grant reaching this party, read from the plane itself
          (`?partyId=`), with `Share` and `Revoke` on it. It opens by default
          exactly while the person is linked, as the handoff has it. */}
      <PersonGrants
        partyId={person.party_id}
        personName={person.name}
        roster={props.roster}
        open={"shared" in props.collapsed ? !props.collapsed.shared : linked}
        onToggle={() => props.onToggleSection("shared")}
        onStatus={props.onStatus}
      />

      <Section
        title={SECTIONS.channels}
        count={person.contact.length}
        collapsible
        open={open("channels")}
        onToggle={() => props.onToggleSection("channels")}
        add={addVerb("channels")}
      >
        {composer && composer.key === "channels" ? (
          <>
            <ChipRow
              label={SECTIONS.channels}
              options={CHANNEL_KINDS.map((kind) => ({
                id: kind,
                label: kind,
              }))}
              active={composer.kind}
              onSelect={(id) =>
                props.onComposerChange({
                  kind: id as ContactChannel["kind"],
                })
              }
            />
            <Field
              label={composer.kind}
              value={composer.value}
              onChange={(value) => props.onComposerChange({ value })}
              trailing={commits}
            />
          </>
        ) : null}
        {person.contact.length === 0 && !composing("channels") ? (
          <EmptyState title={EMPTY.channels} />
        ) : (
          person.contact.map((channel) => (
            <Row
              key={channel.channel_id ?? `${channel.kind}:${channel.value}`}
              name={channel.value}
              strong
              sub={channelSub(channel)}
              // The duplicate warning is the NAMES the value collides with,
              // in the consequence tone. `people-copy.ts` carries no sentence
              // for this yet, and a name the member can recognise says more
              // than a warning that names nothing.
              {...(channel.duplicate_names?.length
                ? {
                    meta: channel.duplicate_names.join(" · "),
                    metaNet: true,
                  }
                : {})}
              trailing={
                <Verb
                  label="✕"
                  quiet
                  ariaLabel={LABELS.removeChannel(channel.kind)}
                  onClick={() => props.onDeleteChannel(channel)}
                />
              }
            />
          ))
        )}
      </Section>

      <Section
        title={SECTIONS.dates}
        count={person.dates.length}
        collapsible
        open={open("dates")}
        onToggle={() => props.onToggleSection("dates")}
        add={addVerb("dates")}
      >
        {composer && composer.key === "dates" ? (
          <>
            <Field
              label={FIELDS.dateLabel}
              value={composer.label}
              onChange={(label) => props.onComposerChange({ label })}
            />
            <Field
              label={FIELDS.date}
              value={composer.monthDay}
              placeholder={FIELDS.datePlaceholder}
              onChange={(monthDay) => props.onComposerChange({ monthDay })}
              trailing={commits}
            />
          </>
        ) : null}
        {person.dates.length === 0 && !composing("dates") ? (
          <EmptyState title={EMPTY.dates} />
        ) : (
          person.dates.map((date) => (
            <Row
              key={date.date_id}
              name={`${date.label} · ${monthDayLabel(date.month_day)}`}
              strong
              sub={
                date.reminder_on ? FRAGMENTS.reminderOn : FRAGMENTS.reminderOff
              }
              trailing={
                <Verb
                  label={date.reminder_on ? VERBS.mute : VERBS.remind}
                  onClick={() =>
                    props.onToggleReminder(date.date_id, date.label)
                  }
                />
              }
            />
          ))
        )}
      </Section>

      <Section
        title={SECTIONS.notes}
        count={person.notes.length}
        collapsible
        open={open("notes")}
        onToggle={() => props.onToggleSection("notes")}
        add={addVerb("notes")}
      >
        {composer && composer.key === "notes" ? (
          <Field
            label={SECTIONS.notes}
            value={composer.value}
            onChange={(value) => props.onComposerChange({ value })}
            trailing={commits}
          />
        ) : null}
        {person.notes.length === 0 && !composing("notes") ? (
          <EmptyState title={EMPTY.notes} />
        ) : (
          person.notes.map((note) => (
            // THE ONE ROW THIS SCREEN COMPOSES RATHER THAN CALLS. `Row` sets
            // its name on one ellipsised line, and a note is a body of
            // member-written prose the handoff wraps; `RowProps` carries no
            // wrap mode and `Shared.tsx` is frozen this wave, so the note
            // takes the shared `.wrapText` recipe inside the shared row's own
            // classes — no new geometry, no second row definition.
            <div className={shared.row} key={note.annotation_id}>
              <div className={shared.rowMain}>
                <span className={shared.wrapText}>
                  {displayText(note.text)}
                </span>
                <span className={shared.rowSub} data-numeric="true">
                  {whenLabel(note.created_at)}
                </span>
              </div>
            </div>
          ))
        )}
      </Section>

      {/* The two acts that end a person. `Trash` is the outlined consequence
          recipe — destructive is never a fill. */}
      <Commits narrow={props.narrow}>
        <button
          type="button"
          className="kit-btn secondary"
          onClick={props.onMerge}
        >
          {VERBS.merge}
        </button>
        <button
          type="button"
          className="kit-btn destructive"
          onClick={props.onTrash}
        >
          {VERBS.trash}
        </button>
      </Commits>
    </section>
  );
}
