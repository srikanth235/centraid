/**
 * THE GRANT SHEET, native seat (issue #825).
 *
 * The web sheet's twin, and deliberately not its copy: every sentence, every
 * state token and the whole write door come from
 * `@centraid/blueprints/apps/_shared/grant-*`, so the only thing restated here
 * is what React Native genuinely renders differently. Two entries, one core:
 *
 *  - AUDIENCE-FIRST is primary (ruling G-audience): person → what → capability.
 *  - OBJECT-FIRST pins `subject`; the "what" step becomes a fixed line and the
 *    standing list becomes the object side. It is an entry, not a second sheet.
 *
 * `edit` is drawn only where the gateway's declared subject registry answers
 * it. Outcomes go to the host's status line, never to a toast, and the
 * revoke confirm says the removal is REQUESTED — the only honest thing to say
 * about a vault on someone else's device.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";

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
} from "@centraid/blueprints/apps/_shared/grant-copy";
import type {
  GrantDoor,
  SubjectRegistry,
} from "@centraid/blueprints/apps/_shared/grant-door";
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
} from "@centraid/blueprints/apps/_shared/grant-plane";
import type {
  GrantAudienceOption,
  GrantCapability,
  GrantChannel,
  GrantRecord,
  GrantSubject,
} from "@centraid/blueprints/apps/_shared/grant-plane";

import { Text } from "../components/NativeText";
import TopSafeArea from "../components/TopSafeArea";
import { useReplica } from "../replica/ReplicaProvider";
import { borders, radii, spacing, t, useTheme } from "../theme";
import { nativeGrantDoor } from "./grants-transport";

export interface GrantSheetProps {
  visible: boolean;
  onClose: () => void;
  /** People and named circles this sheet may name. Ordered by the host. */
  audiences: readonly GrantAudienceOption[];
  /** Everything the host can offer to share. Ignored when `subject` is set. */
  subjects?: readonly GrantSubject[];
  /** OBJECT-FIRST entry: the one subject this sheet was opened over. */
  subject?: GrantSubject;
  /** Preselect an audience — a person screen opening the sheet on them. */
  audienceId?: string;
  /** The host's one status line. Every outcome is reported here. */
  onStatus: (message: string) => void;
  /** The grant plane. Defaults to this seat's authed transport. */
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

/** The audience a grant names, in the member's words — never a raw id. */
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

export default function GrantSheet(props: GrantSheetProps): React.JSX.Element {
  const { colors } = useTheme();
  const replica = useReplica();
  const gatewayBase = replica.gatewayBase ?? "";
  const door = useMemo(
    () => props.door ?? nativeGrantDoor(gatewayBase),
    [props.door, gatewayBase]
  );

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
    if (!props.visible) return;
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
  }, [props.visible, props.audienceId, door]);

  // The standing read follows whichever question the sheet was opened with:
  // the object side when a subject is pinned, the person side otherwise.
  //
  // REACH IS A FACT ABOUT THE PERSON, not about which door was used. An
  // object-first sheet still names someone, so it still owes an honest reach
  // line — and its own read, since `forSubject` cannot answer one.
  useEffect(() => {
    if (!props.visible) return;
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
  }, [props.visible, pinnedType, pinnedId, audienceKind, audienceKey, door]);

  // A grant already standing over this exact pair opens on ITS capability:
  // proposing `view` over a live `edit` reads as a downgrade nobody asked for.
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
  const reach = channelReach(channel);
  const blocked =
    !audience ||
    !subject ||
    registryPending ||
    registryUnreadable ||
    notOfferable ||
    busy;

  const submit = async (): Promise<void> => {
    if (!audience || !subject || blocked) return;
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
    // The route's sentence, verbatim — it is derived from what each delivered
    // copy actually did, and nothing here may soften it.
    props.onStatus(outcome.message);
    if (outcome.ok)
      setStanding((current) =>
        (current ?? []).filter((row) => row.grantId !== grant.grantId)
      );
  };

  const pill = (
    key: string,
    label: string,
    selected: boolean,
    onPress: () => void
  ): React.JSX.Element => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      key={key}
      onPress={onPress}
      style={[
        styles.pill,
        { borderColor: colors.line },
        selected && { backgroundColor: colors.bgElev },
      ]}
    >
      <Text style={{ color: selected ? colors.text : colors.textSoft }}>
        {label}
      </Text>
    </Pressable>
  );

  const confirmView = confirming ? (
    <View style={styles.section}>
      <Text style={[styles.title, { color: colors.text }]}>
        {revokeConfirmTitle(audienceLabelFor(confirming, props.audiences))}
      </Text>
      <Text style={[styles.reading, { color: colors.text }]}>
        {revokeConfirmBody(
          audienceLabelFor(confirming, props.audiences),
          subjectNoun(confirming.subjectType)
        )}
      </Text>
      <View style={styles.confirmRow}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setConfirming(null)}
          style={[styles.pill, { borderColor: colors.line }]}
        >
          <Text style={{ color: colors.text }}>{REVOKE_CANCEL_ACTION}</Text>
        </Pressable>
        {/* Destructive is OUTLINED in `--net`, never a fill. */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => void revoke(confirming)}
          style={[styles.pill, { borderColor: colors.net }]}
        >
          <Text style={{ color: colors.net }}>{REVOKE_CONFIRM_ACTION}</Text>
        </Pressable>
      </View>
    </View>
  ) : null;

  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onClose}
      presentationStyle="pageSheet"
      visible={props.visible}
    >
      <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>
            {GRANT_SHEET_TITLE}
          </Text>
          <Pressable accessibilityRole="button" onPress={props.onClose}>
            <Text style={{ color: colors.accent }}>Cancel</Text>
          </Pressable>
        </View>

        {confirmView ?? (
          <>
            <ScrollView contentContainerStyle={styles.body}>
              <View style={styles.section}>
                <Text style={[styles.eyebrow, { color: colors.textSoft }]}>
                  Person
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.pillRow}>
                    {props.audiences.map((option) =>
                      pill(
                        `${option.kind}:${option.id}`,
                        option.kind === "circle"
                          ? `Named group · ${option.label}`
                          : option.label,
                        option.id === audience?.id,
                        () => {
                          setPicked(null);
                          setAudienceId(option.id);
                        }
                      )
                    )}
                  </View>
                </ScrollView>
                {/* An unknown reach draws the checking line and nothing else:
                    every other label is a claim about this person that only an
                    answered read may make. */}
                {audience?.kind === "party" && audienceKnown ? (
                  <View>
                    <Text
                      style={[
                        styles.reachState,
                        {
                          // "Not yet, and not wrong" is `--seam`, not an error
                          // rung: an unaccepted invitation is neither. A read
                          // that has not answered is quieter than both.
                          color:
                            reach === "severed"
                              ? colors.net
                              : reach === "live" || reach === "unknown"
                                ? colors.textSoft
                                : colors.seam,
                        },
                      ]}
                    >
                      {reachLabel(reach)}
                    </Text>
                    {reachNote(reach) ? (
                      <Text style={[styles.note, { color: colors.textSoft }]}>
                        {reachNote(reach)}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </View>

              <View style={styles.section}>
                <Text style={[styles.eyebrow, { color: colors.textSoft }]}>
                  What
                </Text>
                {props.subject ? (
                  <Text style={[styles.fixedSubject, { color: colors.text }]}>
                    {subjectTitle(props.subject)}
                  </Text>
                ) : (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={styles.pillRow}>
                      {offered.map((candidate) =>
                        pill(
                          subjectKey(candidate),
                          subjectTitle(candidate),
                          subjectKey(candidate) ===
                            (subject ? subjectKey(subject) : ""),
                          () => {
                            // A different subject may answer different verbs,
                            // so the member's pick does not carry across.
                            setPicked(null);
                            setSubjectId(subjectKey(candidate));
                          }
                        )
                      )}
                    </View>
                  </ScrollView>
                )}
              </View>

              <View style={styles.section}>
                <Text style={[styles.eyebrow, { color: colors.textSoft }]}>
                  Access
                </Text>
                <View style={styles.pillRow}>
                  {capabilities.map((candidate) =>
                    pill(
                      candidate,
                      capabilityLabel(candidate),
                      capability === candidate,
                      () => setPicked(candidate)
                    )
                  )}
                </View>
                {contributionNote ? (
                  <Text style={[styles.note, { color: colors.textSoft }]}>
                    {contributionNote}
                  </Text>
                ) : null}
                {notOfferable ? (
                  <Text style={[styles.note, { color: colors.net }]}>
                    {subjectNotOfferable(noun)}
                  </Text>
                ) : null}
                {registryUnreadable ? (
                  <Text style={[styles.note, { color: colors.net }]}>
                    {REGISTRY_UNREADABLE}
                  </Text>
                ) : null}
              </View>

              <View style={styles.section}>
                <Text style={[styles.eyebrow, { color: colors.textSoft }]}>
                  Already shared
                </Text>
                {standing === null ? (
                  <Text style={[styles.note, { color: colors.textSoft }]}>
                    Reading shares…
                  </Text>
                ) : !audienceKnown ? (
                  <Text style={[styles.note, { color: colors.textSoft }]}>
                    {audienceNotKnown(audience?.label ?? "this audience")}
                  </Text>
                ) : rows.length === 0 ? (
                  <Text style={[styles.note, { color: colors.textSoft }]}>
                    {nothingSharedYet(
                      props.subject
                        ? subjectTitle(props.subject)
                        : (audience?.label ?? "this audience")
                    )}
                  </Text>
                ) : (
                  rows.map((grant) => (
                    <View
                      key={grant.grantId}
                      style={[styles.row, { borderColor: colors.line }]}
                    >
                      <View style={styles.rowCopy}>
                        <Text style={{ color: colors.text }}>
                          {props.subject
                            ? audienceLabelFor(grant, props.audiences)
                            : subjectNoun(grant.subjectType)}
                        </Text>
                        <Text
                          style={[
                            styles.note,
                            {
                              color:
                                grantDelivery(grant) === "delivered" ||
                                grantDelivery(grant) === "removed"
                                  ? colors.textSoft
                                  : colors.seam,
                            },
                          ]}
                        >
                          {capabilityLabel(grant.capability)} ·{" "}
                          {deliveryLabel(grantDelivery(grant))}
                        </Text>
                      </View>
                      <Pressable
                        accessibilityLabel={`Revoke ${subjectNoun(grant.subjectType)}`}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: busy }}
                        disabled={busy}
                        onPress={() => setConfirming(grant)}
                        style={[styles.pill, { borderColor: colors.net }]}
                      >
                        <Text style={{ color: colors.net }}>
                          {REVOKE_CONFIRM_ACTION}
                        </Text>
                      </Pressable>
                    </View>
                  ))
                )}
              </View>

              {refusal ? (
                <Text style={[styles.note, { color: colors.net }]}>
                  {refusal}
                </Text>
              ) : null}
            </ScrollView>

            <View style={styles.footer}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: blocked }}
                disabled={blocked}
                onPress={() => void submit()}
                style={[
                  styles.shareButton,
                  {
                    backgroundColor: blocked ? colors.bgSunken : colors.accent,
                  },
                ]}
              >
                <Text style={{ color: colors.textInv }}>
                  {busy ? "Sharing…" : GRANT_SHEET_TITLE}
                </Text>
              </Pressable>
            </View>
          </>
        )}
      </TopSafeArea>
    </Modal>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: spacing[4] },
  confirmRow: { flexDirection: "row", gap: spacing[2] },
  eyebrow: t("eyebrow"),
  fixedSubject: t("bodyStrong"),
  footer: { paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[3],
    justifyContent: "space-between",
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  note: t("small"),
  pill: {
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  pillRow: { flexDirection: "row", gap: spacing[2] },
  reachState: t("annotLabelOn"),
  reading: t("reading"),
  row: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    flexDirection: "row",
    gap: spacing[3],
    justifyContent: "space-between",
    marginBottom: spacing[2],
    minHeight: 58,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  rowCopy: { flex: 1, minWidth: 0 },
  safe: { flex: 1 },
  section: {
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
  shareButton: {
    alignItems: "center",
    borderRadius: radii.md,
    justifyContent: "center",
    minHeight: 46,
  },
  title: t("title"),
});
