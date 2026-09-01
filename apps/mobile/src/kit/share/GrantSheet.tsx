/**
 * Grant sheet, native seat (#825). Audience-first: person → what → capability.
 * Object-first is an ENTRY via `subject`, not a second sheet. Feedback is
 * `onStatus`, never a toast.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import { NOBODY_TO_SHARE_WITH } from "@centraid/blueprints/apps/_shared/grant-audiences";
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
} from "@centraid/blueprints/apps/_shared/grant-copy";
import { isGrantUnreachable } from "@centraid/blueprints/apps/_shared/grant-door";
import type {
  GrantDoor,
  SubjectRegistry,
} from "@centraid/blueprints/apps/_shared/grant-door";
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
} from "@centraid/blueprints/apps/_shared/grant-plane";
import type {
  GrantAudienceOption,
  GrantCapability,
  GrantChannel,
  GrantRecord,
  GrantSubject,
} from "@centraid/blueprints/apps/_shared/grant-plane";

import { Text } from "../components/NativeText";
import Tappable from "../components/Tappable";
import TopSafeArea from "../components/TopSafeArea";
import { useReplica } from "../replica/ReplicaProvider";
import { useTheme } from "../theme";
import { nativeGrantDoor } from "./grant-seat";
import {
  audienceLabelFor,
  subjectKey,
  subjectTitle,
} from "./grant-sheet-labels";
import { styles } from "./GrantSheet.styles";
import { GrantSheetConfirm } from "./GrantSheetConfirm";
import { GrantSheetStanding } from "./GrantSheetStanding";

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

export default function GrantSheet(props: GrantSheetProps): React.JSX.Element {
  const { colors } = useTheme();
  const replica = useReplica();
  const gatewayBase = replica.gatewayBase ?? "";
  const door = useMemo(
    () => props.door ?? nativeGrantDoor(gatewayBase),
    [props.door, gatewayBase]
  );

  // `null` = unread; an empty registry is a claim, so do not paint it early.
  const [registry, setRegistry] = useState<SubjectRegistry | null>(null);
  const [audienceId, setAudienceId] = useState(props.audienceId ?? "");
  const [subjectId, setSubjectId] = useState("");
  // `null` = unchosen; capability is derived at render, not in an effect.
  const [picked, setPicked] = useState<GrantCapability | null>(null);
  const [standing, setStanding] = useState<GrantRecord[] | null>(null);
  // `undefined` until a read answers; `null` paints a claim for one frame.
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
  // Effect keys, not objects: a rebuilt array must not re-read every render.
  const audienceKey = audience?.id ?? "";
  const audienceKind = audience?.kind ?? "party";
  const pinnedType = props.subject?.subjectType ?? "";
  const pinnedId = props.subject?.subjectId ?? "";

  // Deferred off the effect body: sync setState would cascade.
  useEffect(() => {
    if (!props.visible) return;
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
  }, [props.visible, props.audienceId, door]);

  // Reach is about the person, not the door, and `forSubject` cannot answer
  // one — so object-first still owes a reach read.
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
  }, [props.visible, pinnedType, pinnedId, audienceKind, audienceKey, door]);

  // Open on the standing capability: never propose a change.
  // Derived at render; an effect writing it back is a second truth.
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
  // Clamp to drawable: a narrowed standing `edit` must not be posted.
  const capability = drawableCapability(
    capabilities,
    picked ?? defaultCapability(alreadyStanding)
  );
  const noun = subject ? subjectNoun(subject.subjectType) : "shared item";
  // Of unread, empty, refused and unreachable, only empty refuses.
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
  // Unknown audience gets its own sentence; "nothing shared" is a lie.
  // Subject-first lists this subject's grants; audience-first, the audience's.
  const standingEmptyLine = audienceKnown
    ? props.subject
      ? notSharedWithAnyoneYet(subjectTitle(props.subject))
      : nothingSharedYet(audience?.label ?? "this audience")
    : audienceNotKnown(audience?.label ?? "this audience");
  const showStanding = audienceKnown && rows.length > 0;
  const reach = channelReach(channel);
  // The standing answer this submit REPLACES; same verb is not a change.
  const changing =
    alreadyStanding && alreadyStanding.capability !== capability
      ? alreadyStanding
      : undefined;
  const blocked =
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
    if (!audience || !subject || blocked) return;
    // Another verb cannot be widened or narrowed in place (V-table), and the
    // change costs the audience their copy while it runs. Ask first.
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
    // A HELD share is not a granted one (#883): the granted sentence would
    // claim an audience can see something no vault was asked about.
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

  /** Withdraw, then grant again — the plane's only way to change an answer. */
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
    // Route sentence, verbatim: never soften it.
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
      body={revokeConfirmBody(
        audienceLabelFor(confirming, props.audiences),
        subjectNoun(confirming.subjectType)
      )}
      busy={busy}
      cancelLabel={REVOKE_CANCEL_ACTION}
      colors={colors}
      confirmLabel={REVOKE_CONFIRM_ACTION}
      destructive
      onCancel={() => setConfirming(null)}
      onConfirm={() => void revoke(confirming)}
      title={revokeConfirmTitle(audienceLabelFor(confirming, props.audiences))}
    />
  ) : changeConfirm && changing && audience ? (
    <GrantSheetConfirm
      body={changeAccessConfirmBody(subjectNoun(changing.subjectType))}
      busy={busy}
      cancelLabel={CHANGE_ACCESS_CANCEL_ACTION}
      colors={colors}
      confirmLabel={CHANGE_ACCESS_ACTION}
      onCancel={() => setChangeConfirm(false)}
      onConfirm={() => void changeAccess()}
      title={changeAccessConfirmTitle(audience.label, capability)}
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
          <Tappable accessibilityLabel="Cancel" onPress={props.onClose}>
            <Text style={{ color: colors.accent }}>Cancel</Text>
          </Tappable>
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
                          // Not linked yet is `--seam`, not error. Unread is quieter.
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
                {registryProblem ? (
                  <Text style={[styles.note, { color: colors.net }]}>
                    {registryProblem}
                  </Text>
                ) : null}
              </View>

              <GrantSheetStanding
                audiences={props.audiences}
                busy={busy}
                colors={colors}
                emptyLine={standingEmptyLine}
                onRevoke={setConfirming}
                rows={rows}
                showStanding={showStanding}
                standing={standing}
                subject={props.subject}
              />

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
                  {busy
                    ? "Sharing…"
                    : changing
                      ? CHANGE_ACCESS_ACTION
                      : GRANT_SHEET_TITLE}
                </Text>
              </Pressable>
            </View>
          </>
        )}
      </TopSafeArea>
    </Modal>
  );
}
