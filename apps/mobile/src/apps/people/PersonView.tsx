// Person (v12 handoff § Screens 4) — one person in full, one level deep.
//
// Hero, two commits, the record sections, and the two acts that end a person.
// The web renderer (`components/PersonRoute.tsx`) is the reference: the vault
// link is drawn here IN FULL — the hero ring, the vault tags, the `Vaults` and
// `Shared with them` sections — and its two sections are ABSENT ENTIRELY when
// the sharing plane could not be read, because an empty `Not linked yet.` over
// a denied read answers a question nobody could ask.
//
// `Share` AND `Revoke` ARE HERE, AND THEY ARE LIVE (#825). A share is a
// standing grant over an audience × subject × capability, so this screen is
// the grant dashboard the ruling names it — every live grant reaching this
// party, `Revoke` on each row and `Share` on the section that lists them
// (`PersonGrants.tsx`). There is no `Link vault`: linking is not an act a
// member performs.
//
// ADDING IS A FIELD WHERE THE ROW WILL BE, never a new screen (handoff
// deviation 3): each record section's `Add` opens an inline composer.

import React, { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  cadenceLineLabel,
  isOverdue,
  monthDayLabel,
  whenLabel,
} from "@centraid/blueprints/apps/people/format";
import {
  APP_TITLE,
  CONFIRMS,
  EMPTY,
  FIELDS,
  FRAGMENTS,
  LABELS,
  LINK,
  SECTIONS,
  VERBS,
} from "@centraid/blueprints/apps/people/people-copy";
import type { ContactChannel } from "@centraid/blueprints/apps/people/types";

import Button from "../../kit/components/Button";
import ChipsBlock from "../../kit/components/ChipsBlock";
import { Text } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { pageMargin, spacing, t, useTheme } from "../../kit/theme";
import type { PeopleScreenProps } from "../../navigation";
import { usePeopleWrites } from "./people-writes";
import PeopleConfirm from "./PeopleConfirm";
import {
  BackRow,
  Commits,
  EmptyLine,
  FieldRow,
  PeopleSection,
  PersonAvatar,
  PersonRow,
  StarButton,
  VaultTag,
  Verb,
} from "./PeopleKit";
import PeopleScreen from "./PeopleScreen";
import PersonGrants from "./PersonGrants";
import { usePerson } from "./usePeople";

const CHANNEL_KINDS: readonly ContactChannel["kind"][] = [
  "phone",
  "email",
  "handle",
];

/** `phone · work · preferred` — the channel row's second line. */
function channelSub(channel: ContactChannel): string {
  const parts: string[] = [channel.kind];
  if (channel.label) parts.push(channel.label);
  if (channel.preferred) parts.push(FRAGMENTS.preferred);
  return parts.join(" · ");
}

type ComposerKey = "channels" | "dates" | "notes";
interface Composer {
  key: ComposerKey;
  value: string;
  label: string;
  kind: ContactChannel["kind"];
  monthDay: string;
}

export default function PersonView({
  navigation,
  route,
}: PeopleScreenProps<"Person">): React.JSX.Element {
  const { colors } = useTheme();
  const partyId = route.params.personId;
  const { person, loading, roster } = usePerson(partyId);
  const writes = usePeopleWrites(() =>
    navigation.navigate("Settings", { screen: "Approvals" })
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [composer, setComposer] = useState<Composer | null>(null);
  const [confirmTrash, setConfirmTrash] = useState(false);

  const toggle = (key: string): void =>
    setCollapsed((state) => ({ ...state, [key]: !state[key] }));
  const open = (key: ComposerKey): boolean => !collapsed[key];
  const composing = (key: ComposerKey): boolean => composer?.key === key;
  const openComposer = (key: ComposerKey): void =>
    setComposer({ key, value: "", label: "", kind: "phone", monthDay: "" });

  const saveComposer = async (): Promise<void> => {
    if (!composer || !person) return;
    if (composer.key === "notes") {
      if (!composer.value.trim()) return;
      if (await writes.addNote(partyId, composer.value.trim(), person.name))
        setComposer(null);
      return;
    }
    if (composer.key === "dates") {
      if (!composer.label.trim() || !composer.monthDay.trim()) return;
      if (
        await writes.addImportantDate(
          partyId,
          composer.label.trim(),
          composer.monthDay.trim(),
          person.name
        )
      )
        setComposer(null);
      return;
    }
    if (!composer.value.trim()) return;
    if (
      await writes.saveChannel(partyId, {
        kind: composer.kind,
        value: composer.value.trim(),
        ...(composer.label.trim() ? { label: composer.label.trim() } : {}),
      })
    )
      setComposer(null);
  };

  const body = (): React.JSX.Element => {
    if (loading && !person) {
      return <SkeletonRows accessibilityLabel="Reading this person" />;
    }
    // Past the loading gate an absent person is a fact — trashed or merged
    // away in another window — so this screen says so and offers the way back.
    if (!person) return <EmptyLine text={EMPTY.noMatch} />;

    const vaults = person.vaults;
    const invites = person.pending_invites;
    const linksAvailable = vaults !== null;
    const linked = (vaults?.length ?? 0) > 0;
    const overdue = isOverdue(person);

    const composerCommits = (
      <>
        <Verb label={VERBS.save} onPress={() => void saveComposer()} />
        <Verb label={VERBS.cancel} quiet onPress={() => setComposer(null)} />
      </>
    );
    const addVerb = (key: ComposerKey): React.ReactNode =>
      composing(key) ? null : (
        <Verb label={VERBS.add} onPress={() => openComposer(key)} />
      );

    return (
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Hero: avatar with the 2px link ring, name, role, star. */}
        <View style={styles.hero}>
          <PersonAvatar
            person={person}
            hero
            link={linksAvailable ? (linked ? "linked" : "unlinked") : "unknown"}
          />
          <View style={styles.heroText}>
            <Text
              style={[t("title"), { color: colors.text }]}
              numberOfLines={1}
            >
              {person.name}
            </Text>
            {person.role ? (
              <Text style={[t("body"), { color: colors.textSoft }]}>
                {person.role}
              </Text>
            ) : null}
          </View>
          <StarButton
            name={person.name}
            starred={person.starred}
            onToggle={() => void writes.toggleStar(person)}
          />
        </View>

        {/* The vault tags: `Linked vault` per binding (a binding carries only
            an id, and an id is not a name); `Not linked` where there is none.
            Nothing at all while the plane is unreadable. */}
        {linksAvailable ? (
          <View style={styles.tags}>
            {linked ? (
              (vaults ?? []).map((binding) => (
                <VaultTag key={binding.binding_id} label={LINK.vaultRow} />
              ))
            ) : (
              <VaultTag label="Not linked" />
            )}
          </View>
        ) : null}

        {/* `Every 30 days · last 41 days ago`, net exactly while overdue. */}
        <Text
          style={[
            t("annotLabel"),
            styles.numeric,
            { color: overdue ? colors.net : colors.textSoft },
          ]}
        >
          {cadenceLineLabel(person.cadence_days, person)}
        </Text>

        {/* AT MOST ONE FILLED CONTROL PER VIEW: Log is the act this screen
            exists for; Edit stands beside it outlined. (Share / Link vault
            are withheld — module head.) */}
        <Commits>
          <Button
            label={VERBS.log}
            variant="primary"
            onPress={() =>
              navigation.navigate("PersonLog", { personId: partyId })
            }
          />
          <Button
            label={VERBS.edit}
            variant="secondary"
            onPress={() =>
              navigation.navigate("PersonEditor", { personId: partyId })
            }
          />
        </Commits>

        {/* Vaults: always open, never collapses — the one fact this app is
            built around. Bindings first, then unanswered invitations. */}
        {linksAvailable ? (
          <PeopleSection
            title={SECTIONS.vaults}
            count={(vaults?.length ?? 0) + (invites?.length ?? 0)}
          >
            {(vaults?.length ?? 0) === 0 && (invites?.length ?? 0) === 0 ? (
              <EmptyLine text={EMPTY.vaults} />
            ) : (
              <>
                {(vaults ?? []).map((binding, index) => (
                  <PersonRow
                    key={binding.binding_id}
                    name={LINK.vaultRow}
                    sub={LINK.linkedWhen(whenLabel(binding.linked_at))}
                    subNumeric
                    last={
                      index === (vaults?.length ?? 0) - 1 &&
                      (invites?.length ?? 0) === 0
                    }
                  />
                ))}
                {(invites ?? []).map((invite, index) => (
                  <PersonRow
                    key={invite.invitation_id}
                    name={LINK.inviteRow}
                    sub={invite.container_label ?? LINK.inviteWaiting}
                    last={index === (invites?.length ?? 0) - 1}
                  />
                ))}
              </>
            )}
          </PeopleSection>
        ) : null}

        {/* SHARED WITH THEM IS THE GRANT DASHBOARD (`PersonGrants.tsx`):
            every live grant reaching this party, read from the plane itself
            (`?partyId=`), with `Share` and `Revoke` on it. Open by default
            exactly while the person is linked, as the handoff has it. */}
        <PersonGrants
          partyId={partyId}
          personName={person.name}
          roster={roster}
          open={"shared" in collapsed ? !collapsed.shared : linked}
          onToggle={() => toggle("shared")}
        />

        <PeopleSection
          title={SECTIONS.channels}
          count={person.contact.length}
          collapsible
          open={open("channels")}
          onToggle={() => toggle("channels")}
          add={addVerb("channels")}
        >
          {composing("channels") && composer ? (
            <>
              <ChipsBlock
                accessibilityLabel={SECTIONS.channels}
                chips={CHANNEL_KINDS.map((kind) => ({
                  id: kind,
                  label: kind,
                  on: composer.kind === kind,
                  onPress: () => setComposer({ ...composer, kind }),
                }))}
              />
              <FieldRow
                label={composer.kind}
                value={composer.value}
                autoFocus
                onChange={(value) => setComposer({ ...composer, value })}
                trailing={composerCommits}
              />
            </>
          ) : null}
          {person.contact.length === 0 && !composing("channels") ? (
            <EmptyLine text={EMPTY.channels} />
          ) : (
            person.contact.map((channel, index) => (
              <PersonRow
                key={channel.channel_id ?? `${channel.kind}:${channel.value}`}
                name={channel.value}
                sub={channelSub(channel)}
                {...(channel.duplicate_names?.length
                  ? { meta: channel.duplicate_names.join(" · "), metaNet: true }
                  : {})}
                trailing={
                  channel.channel_id ? (
                    <Verb
                      label="✕"
                      quiet
                      accessibilityLabel={LABELS.removeChannel(channel.kind)}
                      onPress={() => void writes.deleteChannel(channel)}
                    />
                  ) : undefined
                }
                last={index === person.contact.length - 1}
              />
            ))
          )}
        </PeopleSection>

        <PeopleSection
          title={SECTIONS.dates}
          count={person.dates.length}
          collapsible
          open={open("dates")}
          onToggle={() => toggle("dates")}
          add={addVerb("dates")}
        >
          {composing("dates") && composer ? (
            <>
              <FieldRow
                label={FIELDS.dateLabel}
                value={composer.label}
                autoFocus
                onChange={(label) => setComposer({ ...composer, label })}
              />
              <FieldRow
                label={FIELDS.date}
                value={composer.monthDay}
                placeholder={FIELDS.datePlaceholder}
                onChange={(monthDay) => setComposer({ ...composer, monthDay })}
                trailing={composerCommits}
              />
            </>
          ) : null}
          {person.dates.length === 0 && !composing("dates") ? (
            <EmptyLine text={EMPTY.dates} />
          ) : (
            person.dates.map((date, index) => (
              <PersonRow
                key={date.date_id}
                name={`${date.label} · ${monthDayLabel(date.month_day)}`}
                sub={
                  date.reminder_on
                    ? FRAGMENTS.reminderOn
                    : FRAGMENTS.reminderOff
                }
                trailing={
                  <Verb
                    label={date.reminder_on ? VERBS.mute : VERBS.remind}
                    onPress={() =>
                      void writes.toggleReminder(
                        date.date_id,
                        date.label,
                        date.reminder_on
                      )
                    }
                  />
                }
                last={index === person.dates.length - 1}
              />
            ))
          )}
        </PeopleSection>

        <PeopleSection
          title={SECTIONS.notes}
          count={person.notes.length}
          collapsible
          open={open("notes")}
          onToggle={() => toggle("notes")}
          add={addVerb("notes")}
        >
          {composing("notes") && composer ? (
            <FieldRow
              label={SECTIONS.notes}
              value={composer.value}
              autoFocus
              onChange={(value) => setComposer({ ...composer, value })}
              trailing={composerCommits}
            />
          ) : null}
          {person.notes.length === 0 && !composing("notes") ? (
            <EmptyLine text={EMPTY.notes} />
          ) : (
            person.notes.map((note, index) => (
              <PersonRow
                key={note.annotation_id}
                name={note.text}
                wrap
                sub={whenLabel(note.created_at)}
                subNumeric
                last={index === person.notes.length - 1}
              />
            ))
          )}
        </PeopleSection>

        {/* The two acts that end a person. Trash is the outlined consequence
            recipe — destructive is never a fill. */}
        <Commits>
          <Button
            label={VERBS.merge}
            variant="secondary"
            onPress={() =>
              navigation.navigate("PersonMerge", { personId: partyId })
            }
          />
          <Button
            label={VERBS.trash}
            variant="destructive"
            onPress={() => setConfirmTrash(true)}
          />
        </Commits>
      </ScrollView>
    );
  };

  return (
    <PeopleScreen current="people">
      <TopSafeArea edges={[]} style={styles.page}>
        <View style={styles.body}>
          <BackRow
            destination={APP_TITLE}
            onPress={() => navigation.popTo("PeopleHome", {})}
          />
          {body()}
        </View>
      </TopSafeArea>
      <PeopleConfirm
        visible={confirmTrash}
        title={CONFIRMS.trash.title(person?.name ?? "")}
        body={CONFIRMS.trash.body}
        verb={CONFIRMS.trash.verb}
        onCancel={() => setConfirmTrash(false)}
        onConfirm={() => {
          setConfirmTrash(false);
          if (!person) return;
          void writes
            .trashPerson({ party_id: partyId, name: person.name })
            .then((landed) => {
              if (landed) navigation.popTo("PeopleHome", {});
            });
        }}
      />
    </PeopleScreen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: pageMargin },
  hero: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    paddingVertical: spacing[3],
  },
  heroText: { flex: 1, gap: 2, minWidth: 0 },
  numeric: { fontVariant: t("mono").fontVariant },
  page: { flex: 1 },
  scroll: { paddingBottom: spacing[6] },
  tags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    paddingBottom: spacing[2],
  },
});
