import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { parseCommonsInvite } from "@centraid/blueprints/apps/_shared/commons-invite";
import { formatBytes } from "@centraid/design";

import Icon from "../kit/components/Icon";
import { Text, TextInput } from "../kit/components/NativeText";
import TopSafeArea from "../kit/components/TopSafeArea";
import { useReplica } from "../kit/replica/ReplicaProvider";
import { density, radii, t, useTheme } from "../kit/theme";
import {
  answerPendingEdge,
  listEdges,
  listPendingEdges,
} from "../lib/replica/edges-transport";
import type { GatewayEdge, PendingEdge } from "../lib/replica/edges-transport";
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

function vaultLabel(vaultId: string, links: readonly GatewayLink[]): string {
  for (const link of links) {
    if (link.vaultA === vaultId) return link.labelA ?? "Linked person";
    if (link.vaultB === vaultId) return link.labelB ?? "Linked person";
  }
  return "Linked person";
}

export default function SharingScreen({
  navigation,
}: SettingsScreenProps<"Sharing">): React.JSX.Element {
  const { colors } = useTheme();
  const replica = useReplica();
  const [links, setLinks] = useState<GatewayLink[]>([]);
  const [edges, setEdges] = useState<GatewayEdge[]>([]);
  const [pending, setPending] = useState<PendingEdge[]>([]);
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
      listPendingEdges(replica.gatewayBase),
      listCommonsInvitations(replica.gatewayBase, replica.vaultId),
      listCommonsRecovery(replica.gatewayBase, replica.vaultId),
    ])
      .then(
        ([
          nextLinks,
          nextEdges,
          nextPending,
          nextCommonsInvitations,
          nextCommonsRecovery,
        ]) => {
          setLinks(nextLinks);
          setEdges(nextEdges);
          setPending(nextPending);
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
  const recoveryConcerns = commonsRecovery.filter(
    (entry) =>
      entry.steward.presence === "degraded" ||
      entry.steward.presence === "absent" ||
      entry.steward.presence === "link-down" ||
      entry.steward.presence === "parked"
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
              const key = `recover:${entry.grantId}`;
              return (
                <View
                  key={key}
                  style={[
                    styles.card,
                    {
                      backgroundColor: colors.bgElev,
                      borderColor: colors.line,
                    },
                  ]}
                >
                  <Text style={[t("body"), { color: colors.text }]}>
                    Steward {entry.steward.presence}
                  </Text>
                  <Text style={[t("small"), { color: colors.textSoft }]}>
                    {entry.containerType}
                    {entry.steward.silentForMs
                      ? ` · unreachable for ${Math.floor(entry.steward.silentForMs / 86_400_000)} days`
                      : ""}
                    {entry.steward.fault ? ` · ${entry.steward.fault}` : ""}
                  </Text>
                  {entry.steward.presence === "parked" ? null : (
                    <Pressable
                      accessibilityRole="button"
                      disabled={busyId === key}
                      onPress={() =>
                        replica.gatewayBase &&
                        void act(key, () =>
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
                  )}
                </View>
              );
            })}
          </Section>
        ) : null}

        {pending.length ? (
          <Section title="Waiting for your decision" colors={colors}>
            {pending.map((row) => (
              <View
                key={row.edgeId}
                style={[
                  styles.card,
                  { backgroundColor: colors.bgElev, borderColor: colors.line },
                ]}
              >
                <Text style={[t("body"), { color: colors.text }]}>
                  {vaultLabel(row.peerVaultId, links)} shared {row.itemCount}{" "}
                  {row.itemType}
                </Text>
                <Text style={[t("small"), { color: colors.textSoft }]}>
                  Nothing is written until you accept.
                </Text>
                <View style={styles.rowActions}>
                  {(["accept", "refuse"] as const).map((decision) => (
                    <Pressable
                      key={decision}
                      accessibilityRole="button"
                      disabled={busyId === row.edgeId}
                      onPress={() =>
                        replica.gatewayBase &&
                        void act(row.edgeId, () =>
                          answerPendingEdge(
                            replica.gatewayBase!,
                            row.edgeId,
                            decision
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
                              decision === "accept"
                                ? colors.accent
                                : colors.textSoft,
                          },
                        ]}
                      >
                        {decision === "accept" ? "Accept" : "Refuse"}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ))}
          </Section>
        ) : null}

        <Section title="Redeem a shared-space invite" colors={colors}>
          <Text style={[t("small"), { color: colors.textSoft }]}>
            Create your vault first. If the sharer is remote, connect with them,
            then paste the one-time invitation here.
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
                setErrorMessage("That shared-space invitation is invalid.");
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

        <Section title="Recent direct copies" colors={colors}>
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
                    {edge.audienceLabel ||
                      vaultLabel(edge.audienceVaultId, links)}
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
              No direct copies yet.
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
                gatewayBase={replica.gatewayBase}
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
