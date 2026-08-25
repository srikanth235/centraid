/**
 * Grant sheet, native seat (#825). Audience-first (G-audience): person → what
 * → capability. Object-first is an ENTRY via `subject`, not a second sheet.
 * `edit` only where the subject registry answers it. Feedback is `onStatus`,
 * never a toast.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import { NOBODY_TO_SHARE_WITH } from "@centraid/blueprints/apps/_shared/grant-audiences";
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
  REVOKE_CONFIRM_ACTION,
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
import { useTheme } from "../theme";
import { nativeGrantDoor } from "./grants-transport";
import { styles } from "./GrantSheet.styles";
import { GrantSheetConfirm } from "./GrantSheetConfirm";

export interface GrantSheetProps {
  visible: boolean;
  onClose: () => void;
  audiences: readonly GrantAudienceOption[];
  subjects?: readonly GrantSubject[];
  /** Object-first entry. */
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

  // `null` = unread. Empty registry is "cannot be shared" — do not paint that early.
  const [registry, setRegistry] = useState<SubjectRegistry | null>(null);
  const [audienceId, setAudienceId] = useState(props.audienceId ?? "");
  const [subjectId, setSubjectId] = useState("");
  // `null` = unchosen; capability is derived at render, not in an effect.
  const [picked, setPicked] = useState<GrantCapability | null>(null);
  const [standing, setStanding] = useState<GrantRecord[] | null>(null);
  // `undefined` until a read answers. `null` would paint "Not reached yet" for one frame.
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
  // Effect keys, not objects — a rebuilt roster array must not re-read every render.
  const audienceKey = audience?.id ?? "";
  const audienceKind = audience?.kind ?? "party";
  const pinnedType = props.subject?.subjectType ?? "";
  const pinnedId = props.subject?.subjectId ?? "";

  // Reset + registry read deferred off the effect body — sync setState would cascade.
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

  // Reach is about the person, not the door. Object-first still names
  // someone, so it still owes a reach read (`forSubject` cannot answer one).
  useEffect(() => {
    if (!props.visible) return;
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

  // Open on the standing capability — do not propose a downgrade or a widen.
  // Derived at render; an effect writing it back would be a second source of truth.
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
  // Clamp to drawable: a standing `edit` the registry narrowed must not be posted.
  const capability = drawableCapability(
    capabilities,
    picked ?? defaultCapability(alreadyStanding)
  );
  const noun = subject ? subjectNoun(subject.subjectType) : "shared item";
  // Three states: unread, empty-for-subject, unreadable. Only the middle is refusal.
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
  // Unknown audience gets its own sentence — "nothing shared" is a lie.
  const standingEmptyLine = audienceKnown
    ? nothingSharedYet(
        props.subject
          ? subjectTitle(props.subject)
          : (audience?.label ?? "this audience")
      )
    : audienceNotKnown(audience?.label ?? "this audience");
  const showStanding = audienceKnown && rows.length > 0;
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
    // Route sentence, verbatim — nothing here may soften it.
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
    <GrantSheetConfirm
      audienceLabel={audienceLabelFor(confirming, props.audiences)}
      busy={busy}
      colors={colors}
      onCancel={() => setConfirming(null)}
      onConfirm={() => void revoke(confirming)}
      subjectNoun={subjectNoun(confirming.subjectType)}
    />
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
                {/* Empty picker is not an answer (#825). Unreadable roster never opens here. */}
                {props.audiences.length === 0 ? (
                  <Text style={{ color: colors.textSoft }}>
                    {NOBODY_TO_SHARE_WITH}
                  </Text>
                ) : null}
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
                {/* Unknown reach: checking line only — other labels are claims. */}
                {audience?.kind === "party" && audienceKnown ? (
                  <View>
                    <Text
                      style={[
                        styles.reachState,
                        {
                          // Unaccepted invitation is `--seam`, not error. Unread is quieter.
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
                            // Different subject, different verbs — pick does not carry.
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
                ) : showStanding ? (
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
                ) : (
                  <Text style={[styles.note, { color: colors.textSoft }]}>
                    {standingEmptyLine}
                  </Text>
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
