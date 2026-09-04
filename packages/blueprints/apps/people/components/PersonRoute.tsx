// Person screen (v12 handoff § Screens 4): hero, two commits, three record
// sections, the acts that end a person. Rows/chips/metrics come from
// Shared.tsx so screen and roster cannot disagree.
// Vault-link section is ABSENT when the sharing plane could not be read (null
// `vaults`) — never an empty answer over a denied read. A share that has not
// reached them yet is said by the grant dashboard below, which reads the live
// plane (#929); this section is the LINK alone. Share/Revoke are live (#825);
// no `Link vault` commit — linking is not a member act. Adding is a composer field where the row will be, never a new
// screen; composer state lives in app-root.
import type { ReactNode } from "react";

import { LoadingSkeleton } from "../../_shared/LoadingSkeleton.tsx";
import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
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

/** Channel kinds the vault stores; chip word IS stored word (LOG_KINDS). */
const CHANNEL_KINDS: readonly ContactChannel["kind"][] = [
  "phone",
  "email",
  "handle",
];

/** `phone · work · preferred`; absent labels leave no empty separator. */
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

  // Past the gate an absent person is a fact, not a pending read.
  const person = props.person;
  if (!person) return <EmptyState title={EMPTY.noMatch} />;

  const open = (key: ComposerKey): boolean => !props.collapsed[key];
  const composing = (key: ComposerKey): boolean => props.composer?.key === key;

  const commits = (
    <>
      <Verb label={VERBS.save} onClick={props.onComposerSave} />
      <Verb label={VERBS.cancel} quiet onClick={props.onComposerCancel} />
    </>
  );

  // Add draws only while its composer is closed — an open composer IS the add.
  const addVerb = (key: ComposerKey): ReactNode =>
    composing(key) ? null : (
      <Verb label={VERBS.add} onClick={() => props.onOpenComposer(key)} />
    );

  const composer = props.composer;
  const overdue = isOverdue(person);

  // The sharing plane answers all three or none; one flag gates sections + ring.
  const vaults = person.vaults;
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
        <PendingWriteActions
          row={person as unknown as Record<string, unknown>}
          onEdit={props.onEdit}
        />
        <StarButton
          name={person.name}
          starred={person.starred}
          onToggle={props.onToggleStar}
        />
      </div>

      {/* Net exactly while past cadence; whole line from format.ts. */}
      <CadenceLine
        text={cadenceLineLabel(person.cadence_days, person)}
        net={overdue}
      />

      {/* At most one filled control per view: Log primary, Edit outlined. */}
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

      {/* Always open, never collapsible: the live bindings, and nothing else
          — a link is a fact this vault holds. */}
      {linksAvailable ? (
        <Section title={SECTIONS.vaults} count={vaults?.length ?? 0}>
          {(vaults?.length ?? 0) === 0 ? (
            <EmptyState title={EMPTY.vaults} />
          ) : (
            (vaults ?? []).map((binding) => (
              <Row
                key={binding.binding_id}
                name={LINK.vaultRow}
                strong
                sub={LINK.linkedWhen(whenLabel(binding.linked_at))}
                subNumeric
              />
            ))
          )}
        </Section>
      ) : null}

      {/* Grant dashboard (PersonGrants.tsx): every live grant reaching this
          party; open by default exactly while linked. */}
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
              // Meta = the NAMES the value collides with, consequence tone.
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
            // Composed directly: Row ellipsises names; notes wrap via the
            // shared .wrapText recipe — no second row definition.
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

      {/* Destructive is outlined, never filled. */}
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
