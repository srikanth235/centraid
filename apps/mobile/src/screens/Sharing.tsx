import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { parseCommonsInvite } from "@centraid/blueprints/apps/_shared/commons-invite";
import {
  SHARING_INVALID_INVITE,
  SHARING_STEWARD_PARKED,
  sharingSilentForDays,
  sharingStewardSilent,
} from "@centraid/client/sharing-copy";
import { formatBytes } from "@centraid/design";

import Icon from "../kit/components/Icon";
import { Text, TextInput } from "../kit/components/NativeText";
import TopSafeArea from "../kit/components/TopSafeArea";
import { useReplica } from "../kit/replica/ReplicaProvider";
import { density, radii, t, useTheme } from "../kit/theme";
import { listEdges } from "../lib/replica/edges-transport";
import type { GatewayEdge } from "../lib/replica/edges-transport";
import { approveLink, listLinks } from "../lib/replica/links-transport";
import type { GatewayLink } from "../lib/replica/links-transport";
import {
  answerCommonsInvitation,
  claimCommonsInvitation,
  listCommonsInvitations,
  listCommonsRecovery,
  recoverCommons,
} from "../lib/replica/placement-transport";
import type {
  CommonsInvitation,
  CommonsRecoveryGrant,
} from "../lib/replica/placement-transport";
import type { SettingsScreenProps } from "../navigation";
import SharingLinkRow, { LinkTicketPanel } from "./SharingLinkRow";

const DAY_MS = 24 * 60 * 60 * 1000;

function stewardLine(entry: CommonsRecoveryGrant): string {
  const silent = entry.steward.silentForMs;
  const days = silent === undefined ? 0 : Math.floor(silent / DAY_MS);
  return [
    entry.containerType,
    days > 0 ? sharingSilentForDays(days) : "",
    entry.steward.fault ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function vaultLabel(vaultId: string, links: readonly GatewayLink[]): string {
  for (const link of links) {
    if (link.vaultA === vaultId) return link.labelA ?? vaultId;
    if (link.vaultB === vaultId) return link.labelB ?? vaultId;
  }
  return vaultId;
}

export default function SharingScreen({
  navigation,
}: SettingsScreenProps<"Sharing">): React.JSX.Element {
  const { colors } = useTheme();
  const replica = useReplica();
  const [links, setLinks] = useState<GatewayLink[]>([]);
  const [edges, setEdges] = useState<GatewayEdge[]>([]);
  const [commonsInvitations, setCommonsInvitations] = useState<
    CommonsInvitation[]
  >([]);
  const [commonsRecovery, setCommonsRecovery] = useState<
    CommonsRecoveryGrant[]
  >([]);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [commonsInviteCode, setCommonsInviteCode] = useState("");

  const refresh = useCallback((): void => {
    if (!replica.gatewayBase || !replica.vaultId) return;
    void Promise.all([
      listLinks(replica.gatewayBase),
      listEdges(replica.gatewayBase),
      listCommonsInvitations(replica.gatewayBase, replica.vaultId),
      listCommonsRecovery(replica.gatewayBase, replica.vaultId),
    ])
      .then(
        ([
          nextLinks,
          nextEdges,
          nextCommonsInvitations,
          nextCommonsRecovery,
        ]) => {
          setLinks(nextLinks);
          setEdges(nextEdges);
          setCommonsInvitations(nextCommonsInvitations);
          setCommonsRecovery(nextCommonsRecovery);
          setErrorMessage(undefined);
        }
      )
      .catch((error: unknown) =>
        setErrorMessage(error instanceof Error ? error.message : String(error))
      );
  }, [replica.gatewayBase, replica.vaultId]);

  useEffect(refresh, [refresh]);

  const act = async (
    id: string,
    action: () => Promise<unknown>
  ): Promise<void> => {
    setBusyId(id);
    try {
      await action();
      refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(undefined);
    }
  };
  const snapshots = edges.filter((edge) => edge.mode === "snapshot");
  // A grant this seat already re-founded has a live successor, and a steward
  // this device simply cannot reach (`link-down`) proves nothing — neither is
  // a concern to put in front of the owner.
  const recoveryConcerns = commonsRecovery.filter(
    (entry) =>
      !entry.supersededBy &&
      (entry.steward.presence === "degraded" ||
        entry.steward.presence === "absent" ||
        entry.steward.presence === "parked")
  );

  return (
    <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[t("title"), { color: colors.text }]}>
            People &amp; circles
          </Text>
          <Text style={[t("small"), { color: colors.textSoft }]}>
            {links.length} {links.length === 1 ? "person" : "people"}
          </Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {errorMessage ? (
          <Text style={[t("small"), { color: colors.danger }]}>
            {errorMessage}
          </Text>
        ) : null}

        {recoveryConcerns.length ? (
          <Section title="Shared-space recovery" colors={colors}>
            {recoveryConcerns.map((entry) => {
              const busyKey = `recover:${entry.grantId}`;
              return (
                <View
                  key={busyKey}
                  style={[
                    styles.card,
                    {
                      backgroundColor: colors.bgElev,
                      borderColor: colors.line,
                    },
                  ]}
                >
                  <Text style={[t("body"), { color: colors.text }]}>
                    {entry.steward.presence === "parked"
                      ? SHARING_STEWARD_PARKED
                      : sharingStewardSilent(entry.steward.presence)}
                  </Text>
                  <Text style={[t("small"), { color: colors.textSoft }]}>
                    {stewardLine(entry)}
                  </Text>
                  {entry.steward.presence === "absent" ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={busyId === busyKey}
                      onPress={() =>
                        replica.gatewayBase &&
                        void act(busyKey, () =>
                          recoverCommons(
                            replica.gatewayBase!,
                            entry.actorVaultId,
                            entry.grantId
                          )
                        )
                      }
                      style={[styles.pill, { borderColor: colors.line }]}
                    >
                      <Text style={[t("control"), { color: colors.accent }]}>
                        Recover from my copy
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </Section>
        ) : null}

        <Section title="Redeem a shared-space invite" colors={colors}>
          <Text style={[t("small"), { color: colors.textSoft }]}>
            Create your vault first, then paste the one-time invitation here.
          </Text>
          <TextInput
            accessibilityLabel="Shared-space invitation"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="centraid://commons-invite…"
            placeholderTextColor={colors.textFaint}
            value={commonsInviteCode}
            onChangeText={setCommonsInviteCode}
            style={[
              styles.inviteInput,
              {
                backgroundColor: colors.bgElev,
                borderColor: colors.line,
                color: colors.text,
              },
            ]}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!commonsInviteCode.trim() || !replica.vaultId}
            onPress={() => {
              const claim = parseCommonsInvite(commonsInviteCode);
              if (!claim) {
                setErrorMessage(SHARING_INVALID_INVITE);
                return;
              }
              const actorVaultId = replica.vaultId;
              if (!replica.gatewayBase || !actorVaultId) return;
              // Discard the raw one-time secret as soon as it is handed to the
              // authenticated claim request; never log or persist it.
              setCommonsInviteCode("");
              void act("commons:claim", () =>
                claimCommonsInvitation(
                  replica.gatewayBase!,
                  actorVaultId,
                  claim.stewardVaultId,
                  claim.claimToken
                )
              );
            }}
            style={[styles.pill, { borderColor: colors.line }]}
          >
            <Text style={[t("control"), { color: colors.accent }]}>Redeem</Text>
          </Pressable>
        </Section>

        {commonsInvitations.some((row) => row.status === "pending") ? (
          <Section title="Shared spaces offered to you" colors={colors}>
            {commonsInvitations
              .filter((row) => row.status === "pending")
              .map((row) => (
                <View
                  key={row.invitationId}
                  style={[
                    styles.card,
                    {
                      backgroundColor: colors.bgElev,
                      borderColor: colors.line,
                    },
                  ]}
                >
                  <Text style={[t("body"), { color: colors.text }]}>
                    Ongoing shared space from {row.stewardVaultId}
                  </Text>
                  <Text style={[t("small"), { color: colors.textSoft }]}>
                    {formatBytes(row.currentSizeBytes)} now · nothing is written
                    until you accept.
                  </Text>
                  <View style={styles.rowActions}>
                    {(["accept", "refuse"] as const).map((answer) => {
                      const busyKey = `commons:${row.invitationId}`;
                      return (
                        <Pressable
                          key={answer}
                          accessibilityRole="button"
                          disabled={busyId === busyKey}
                          onPress={() =>
                            replica.gatewayBase &&
                            replica.vaultId &&
                            void act(busyKey, () =>
                              answerCommonsInvitation(
                                replica.gatewayBase!,
                                row.invitationId,
                                replica.vaultId!,
                                answer
                              )
                            )
                          }
                          style={[styles.pill, { borderColor: colors.line }]}
                        >
                          <Text
                            style={[
                              t("control"),
                              {
                                color:
                                  answer === "accept"
                                    ? colors.accent
                                    : colors.textSoft,
                              },
                            ]}
                          >
                            {answer === "accept" ? "Accept" : "Refuse"}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ))}
          </Section>
        ) : null}

        <Section title="Recent copies between your vaults" colors={colors}>
          {snapshots.length ? (
            snapshots.map((edge) => (
              <View
                key={edge.edgeId}
                style={[
                  styles.card,
                  { backgroundColor: colors.bgElev, borderColor: colors.line },
                ]}
              >
                <View style={styles.rowBetween}>
                  <Text style={[t("body"), { color: colors.text }]}>
                    {vaultLabel(edge.audienceVaultId, links)}
                  </Text>
                  <Text style={[t("control"), { color: colors.textSoft }]}>
                    {edge.status}
                  </Text>
                </View>
                <Text style={[t("small"), { color: colors.textSoft }]}>
                  {edge.itemType}
                </Text>
              </View>
            ))
          ) : (
            <Text style={[t("small"), { color: colors.textSoft }]}>
              No copies between your vaults yet.
            </Text>
          )}
        </Section>

        <Section title="Link with someone" colors={colors}>
          <LinkTicketPanel
            vaultId={replica.vaultId}
            colors={colors}
            gatewayBase={replica.gatewayBase}
            onLinked={refresh}
          />
        </Section>

        <Section title="People" colors={colors}>
          {links.length ? (
            links.map((link) => (
              <SharingLinkRow
                key={link.linkId}
                link={link}
                busy={busyId === link.linkId}
                colors={colors}
                label={vaultLabel(link.remoteVaultId ?? link.vaultB, links)}
                onApprove={() =>
                  replica.gatewayBase &&
                  void act(link.linkId, () =>
                    approveLink(replica.gatewayBase!, link.linkId)
                  )
                }
              />
            ))
          ) : (
            <Text style={[t("small"), { color: colors.textSoft }]}>
              No people linked yet.
            </Text>
          )}
        </Section>
      </ScrollView>
    </TopSafeArea>
  );
}

function Section({
  title,
  colors,
  children,
}: {
  title: string;
  colors: ReturnType<typeof useTheme>["colors"];
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text
        style={[t("control"), styles.sectionTitle, { color: colors.textSoft }]}
      >
        {title.toUpperCase()}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 18, padding: 18 },
  card: {
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: 6,
    padding: density.comfortable.pad,
  },
  header: { alignItems: "center", flexDirection: "row", gap: 12, padding: 18 },
  headerCopy: { flex: 1 },
  inviteInput: {
    borderRadius: radii.md,
    borderWidth: 1,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  pill: {
    alignSelf: "flex-start",
    borderRadius: radii.md,
    borderWidth: 1,
    marginTop: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  rowActions: { flexDirection: "row", gap: 8, marginTop: 4 },
  rowBetween: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  safe: { flex: 1 },
  section: { gap: 8 },
  sectionTitle: { letterSpacing: 0.6 },
});
