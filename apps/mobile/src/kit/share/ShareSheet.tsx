import * as Clipboard from "expo-clipboard";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  View,
} from "react-native";

import {
  commonsInviteMessage,
  encodeCommonsInvite,
} from "@centraid/blueprints/apps/_shared/commons-invite";
import { manualShareSelection } from "@centraid/blueprints/apps/_shared/named-circle-selection";
import type { PlaceableItemType } from "@centraid/blueprints/apps/_shared/placement-registry";

import { listLinks } from "../../lib/replica/links-transport";
import type { GatewayLink } from "../../lib/replica/links-transport";
import { Text } from "../components/NativeText";
import TopSafeArea from "../components/TopSafeArea";
import { useReplicaQuery } from "../hooks/useReplicaQuery";
import { useReplica } from "../replica/ReplicaProvider";
import { borders, radii, spacing, t, useTheme } from "../theme";
import { useNamedShareCircles } from "./named-circles";
import {
  nativeShareTargets,
  selectionsForNativeCircle,
  selectedNativeShareMembers,
} from "./share-targets";

export type ShareVerb = "share";

interface InviteHandoff {
  partyId: string;
  label: string;
  uri: string;
}

export interface ShareSheetProps {
  visible: boolean;
  onClose: () => void;
  sourceVaultId: string;
  noun: string;
  itemType?: PlaceableItemType;
  itemIds?: readonly string[];
  appLabel?: string;
  onDone: (outcome: { verb: ShareVerb; ok: boolean; message: string }) => void;
}

export default function ShareSheet({
  visible,
  onClose,
  sourceVaultId,
  noun,
  itemType,
  itemIds,
  onDone,
}: ShareSheetProps): React.JSX.Element {
  const { colors } = useTheme();
  const replica = useReplica();
  const parties = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "core.party", limit: 500 }), [])
  );
  const vault = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "core.vault", limit: 1 }), [])
  );
  const [links, setLinks] = useState<GatewayLink[]>([]);
  const [selections, setSelections] = useState<
    Record<string, "read" | "read+write">
  >({});
  const [busy, setBusy] = useState(false);
  const [selectedCircleId, setSelectedCircleId] = useState("");
  const [inviteHandoffs, setInviteHandoffs] = useState<InviteHandoff[]>([]);
  const openInputsRef = useRef({
    gatewayBase: replica.gatewayBase,
  });

  useEffect(() => {
    openInputsRef.current = {
      gatewayBase: replica.gatewayBase,
    };
  });

  useEffect(() => {
    if (!visible) return;
    const { gatewayBase } = openInputsRef.current;
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setBusy(false);
      setSelections({});
      setSelectedCircleId("");
      setInviteHandoffs([]);
      if (!gatewayBase) return;
      try {
        const nextLinks = await listLinks(gatewayBase);
        if (active) setLinks(nextLinks);
      } catch {
        if (active) setLinks([]);
      }
    });
    return () => {
      active = false;
    };
  }, [visible]);

  const ownerPartyId =
    typeof vault.rows[0]?.owner_party_id === "string"
      ? vault.rows[0].owner_party_id
      : undefined;
  const destinations = nativeShareTargets({
    sourceVaultId,
    ownerPartyId,
    parties: parties.rows,
    links,
    scopes: replica.scopes ?? [],
  });
  const selected = destinations.flatMap((destination) => {
    const capability = selections[destination.id];
    return capability ? [{ destination, capability }] : [];
  });
  const members = selectedNativeShareMembers(destinations, selections);
  const namedCircles = useNamedShareCircles(destinations, ownerPartyId);

  const share = async (): Promise<void> => {
    if (!replica.session || !itemType || !itemIds?.length || !selected.length)
      return;
    setBusy(true);
    let producedHandoffs = false;
    try {
      const results = await Promise.all(
        itemIds.map((containerId) =>
          replica.session!.share({
            sourceVaultId,
            containerType: itemType,
            containerId,
            members,
            ...(selectedCircleId ? { circleId: selectedCircleId } : {}),
          })
        )
      );
      const handoffs = results.flatMap((result) =>
        (result.claims ?? []).map((claim) => ({
          partyId: claim.partyId,
          label:
            selected.find(
              ({ destination }) => destination.partyId === claim.partyId
            )?.destination.label ?? "Invited person",
          uri: encodeCommonsInvite({
            stewardVaultId: sourceVaultId,
            claimToken: claim.claimToken,
          }),
        }))
      );
      const invited = selected.filter(
        ({ destination }) => !destination.vaultId
      ).length;
      onDone({
        verb: "share",
        ok: true,
        message: invited
          ? `Shared with ${selected.length} people; ${invited} ${invited === 1 ? "is" : "are"} invited and will join after creating a vault.`
          : `Shared with ${selected.length} ${selected.length === 1 ? "person" : "people"}.`,
      });
      if (handoffs.length) {
        producedHandoffs = true;
        setInviteHandoffs(handoffs);
      }
    } catch (error) {
      onDone({
        verb: "share",
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "Could not share with the selected people.",
      });
    } finally {
      setBusy(false);
      if (!producedHandoffs) onClose();
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>
            Share {noun.toLowerCase()}
          </Text>
          <Pressable accessibilityRole="button" onPress={onClose}>
            <Text style={{ color: colors.accent }}>Cancel</Text>
          </Pressable>
        </View>

        <Text style={[styles.note, { color: colors.textSoft }]}>
          Pick people. Everyone who joins gets the full shared item in their own
          vault and backup.
        </Text>

        {namedCircles.length ? (
          <View style={styles.circleList}>
            <Text style={[t("small"), { color: colors.textSoft }]}>
              Reuse a named circle (optional)
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.circleRow}>
                {namedCircles.map((circle) => (
                  <Pressable
                    key={circle.circleId}
                    accessibilityRole="button"
                    accessibilityState={{
                      selected: selectedCircleId === circle.circleId,
                    }}
                    onPress={() => {
                      const next =
                        selectedCircleId === circle.circleId
                          ? ""
                          : circle.circleId;
                      setSelectedCircleId(next);
                      setSelections(
                        next
                          ? selectionsForNativeCircle(destinations, circle)
                          : {}
                      );
                    }}
                    style={[
                      styles.circlePill,
                      { borderColor: colors.line },
                      selectedCircleId === circle.circleId && {
                        backgroundColor: colors.bgElev,
                      },
                    ]}
                  >
                    <Text style={{ color: colors.accent }}>
                      Named group · {circle.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          </View>
        ) : null}

        {destinations.length === 0 ? (
          <Text style={[styles.empty, { color: colors.textSoft }]}>
            Add someone in People to share with them.
          </Text>
        ) : (
          <ScrollView contentContainerStyle={styles.list}>
            {destinations.map((destination) => {
              const capability = selections[destination.id];
              return (
                <View
                  key={destination.id}
                  style={[
                    styles.row,
                    {
                      backgroundColor: colors.bgElev,
                      borderColor: colors.line,
                    },
                  ]}
                >
                  <Pressable
                    accessibilityLabel={`Share with ${destination.label}`}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: Boolean(capability) }}
                    disabled={busy}
                    onPress={() => {
                      const next = manualShareSelection(
                        selections,
                        destination.id,
                        selections[destination.id] ? undefined : "read+write"
                      );
                      setSelectedCircleId(next.circleId);
                      setSelections(next.selections);
                    }}
                    style={styles.person}
                  >
                    <Text style={[styles.check, { color: colors.accent }]}>
                      {capability ? "✓" : "○"}
                    </Text>
                    <View style={styles.personCopy}>
                      <Text style={[styles.rowTitle, { color: colors.text }]}>
                        {destination.label}
                      </Text>
                      {destination.vaultId ? null : (
                        <Text
                          style={[styles.invited, { color: colors.textSoft }]}
                        >
                          Invited — waiting for a vault
                        </Text>
                      )}
                    </View>
                  </Pressable>
                  {capability ? (
                    <View style={[styles.toggle, { borderColor: colors.line }]}>
                      {(["read", "read+write"] as const).map((candidate) => (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{
                            selected: capability === candidate,
                          }}
                          key={candidate}
                          onPress={() => {
                            const next = manualShareSelection(
                              selections,
                              destination.id,
                              candidate
                            );
                            setSelectedCircleId(next.circleId);
                            setSelections(next.selections);
                          }}
                          style={[
                            styles.toggleTab,
                            capability === candidate && {
                              backgroundColor: colors.bg,
                            },
                          ]}
                        >
                          <Text
                            style={{
                              color:
                                capability === candidate
                                  ? colors.accent
                                  : colors.textSoft,
                            }}
                          >
                            {candidate === "read" ? "Can view" : "Can edit"}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
        )}
        {inviteHandoffs.length ? (
          <View style={styles.handoffs}>
            <Text style={[t("control"), { color: colors.text }]}>
              Send these one-time invitations
            </Text>
            <Text style={[t("small"), { color: colors.textSoft }]}>
              Each person installs Centraid, creates a vault, connects to you if
              remote, redeems this invitation, then accepts its size.
            </Text>
            {inviteHandoffs.map((handoff, index) => (
              <View
                key={`${handoff.partyId}:${index}`}
                style={[styles.handoff, { borderColor: colors.line }]}
              >
                <Text style={[t("body"), { color: colors.text }]}>
                  {handoff.label}
                </Text>
                <View style={styles.inviteActions}>
                  <Pressable
                    accessibilityLabel={`Copy invitation for ${handoff.label}`}
                    accessibilityRole="button"
                    onPress={() =>
                      void Clipboard.setStringAsync(
                        commonsInviteMessage(handoff.uri)
                      )
                    }
                    style={[styles.circlePill, { borderColor: colors.line }]}
                  >
                    <Text style={{ color: colors.accent }}>Copy</Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={`Share invitation with ${handoff.label}`}
                    accessibilityRole="button"
                    onPress={() =>
                      void Share.share({
                        message: commonsInviteMessage(handoff.uri),
                      })
                    }
                    style={[styles.circlePill, { borderColor: colors.line }]}
                  >
                    <Text style={{ color: colors.accent }}>Share</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.footer}>
          {inviteHandoffs.length ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setInviteHandoffs([]);
                onClose();
              }}
              style={[styles.shareButton, { backgroundColor: colors.accent }]}
            >
              <Text style={{ color: colors.textInv }}>Done</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy || selected.length === 0 }}
              disabled={busy || selected.length === 0}
              onPress={() => void share()}
              style={[
                styles.shareButton,
                {
                  backgroundColor:
                    busy || selected.length === 0
                      ? colors.bgSunken
                      : colors.accent,
                },
              ]}
            >
              <Text style={{ color: colors.textInv }}>
                {busy ? "Sharing…" : "Share"}
              </Text>
            </Pressable>
          )}
        </View>
      </TopSafeArea>
    </Modal>
  );
}

const styles = StyleSheet.create({
  circleList: { gap: spacing[1], paddingHorizontal: spacing[4] },
  circlePill: {
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  circleRow: { flexDirection: "row", gap: spacing[2] },
  check: { ...t("body"), width: 20 },
  empty: { ...t("body"), paddingHorizontal: spacing[4], paddingVertical: 18 },
  footer: { paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  handoff: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: spacing[3],
  },
  handoffs: { gap: spacing[2], paddingHorizontal: spacing[4] },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[3],
    justifyContent: "space-between",
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  note: {
    ...t("small"),
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  invited: t("small"),
  inviteActions: { flexDirection: "row", gap: spacing[1] },
  list: { paddingTop: spacing[1] },
  person: {
    alignItems: "center",
    flexDirection: "row",
    flex: 1,
    minHeight: 52,
  },
  personCopy: { flex: 1 },
  row: {
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    marginHorizontal: spacing[4],
    marginBottom: spacing[2],
    minHeight: 58,
    paddingHorizontal: 16,
  },
  rowTitle: t("body"),
  safe: { flex: 1 },
  title: t("title"),
  shareButton: {
    alignItems: "center",
    borderRadius: radii.md,
    minHeight: 46,
    justifyContent: "center",
  },
  toggle: {
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    flexDirection: "row",
    marginBottom: spacing[2],
    width: 180,
    overflow: "hidden",
  },
  toggleTab: { alignItems: "center", flex: 1, paddingVertical: spacing[2] },
});
