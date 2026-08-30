import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { parseCommonsInvite } from "@centraid/blueprints/apps/_shared/commons-invite";
import type { CommonsInviteClaim } from "@centraid/blueprints/apps/_shared/commons-invite";
import { DAY_MS } from "@centraid/blueprints/apps/_shared/format-kit";
import {
  SHARING_INVALID_INVITE,
  SHARING_STEWARD_PARKED,
  sharingSilentForDays,
  sharingStewardSilent,
} from "@centraid/client/sharing-copy";
import { formatBytes } from "@centraid/design";

import Icon from "../kit/components/Icon";
import { Text, TextInput } from "../kit/components/NativeText";
import Tappable from "../kit/components/Tappable";
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
import {
  readShareScopes,
  readShareSection,
  SHARE_READ_LOADING,
  shareAbsentLine,
  sharePartialLine,
} from "./sharing-reads";
import type {
  ScopedShareRead,
  ShareRead,
  ShareRowSource,
  ShareScope,
} from "./sharing-reads";
import SharingLinkRow, { LinkTicketPanel } from "./SharingLinkRow";

const NOT_ASKED: ScopedShareRead<never> = { rows: [], missed: [] };

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

/** Every mounted vault, not the focused one: pairing can grant several and up
 *  to four are mounted. `scopes` is empty only before the replica has mounted,
 *  where the focused vault is the one thing this device knows. */
function sharingScopes(
  scopes: readonly ShareScope[] | undefined,
  vaultId: string | undefined
): ShareScope[] {
  if (scopes?.length)
    return scopes.map(({ vaultId: id, label }) => ({ vaultId: id, label }));
  return vaultId ? [{ vaultId, label: vaultId }] : [];
}

export default function SharingScreen({
  navigation,
  route,
}: SettingsScreenProps<"Sharing">): React.JSX.Element {
  const { colors } = useTheme();
  const replica = useReplica();
  const [links, setLinks] =
    useState<ShareRead<GatewayLink>>(SHARE_READ_LOADING);
  const [edges, setEdges] =
    useState<ShareRead<GatewayEdge>>(SHARE_READ_LOADING);
  const [commonsInvitations, setCommonsInvitations] =
    useState<ScopedShareRead<CommonsInvitation & ShareRowSource>>(NOT_ASKED);
  const [commonsRecovery, setCommonsRecovery] =
    useState<ScopedShareRead<CommonsRecoveryGrant & ShareRowSource>>(NOT_ASKED);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [commonsInviteCode, setCommonsInviteCode] = useState("");
  // One-time means one time: a token this screen has already handed to the
  // claim request is never sent twice, however the effect is re-entered.
  const spentClaims = useRef(new Set<string>());

  const online = replica.online;

  const refresh = useCallback((): void => {
    const base = replica.gatewayBase;
    const scopes = sharingScopes(replica.scopes, replica.vaultId);
    if (!base || !scopes.length) return;
    // Four independent reads, four independent verdicts: one section's refusal
    // may not blank the others, and none of them may answer with `[]`.
    void readShareSection(() => listLinks(base), online).then(setLinks);
    void readShareSection(() => listEdges(base), online).then(setEdges);
    void readShareScopes(
      scopes,
      (vaultId) => listCommonsInvitations(base, vaultId),
      online
    ).then(setCommonsInvitations);
    void readShareScopes(
      scopes,
      (vaultId) => listCommonsRecovery(base, vaultId),
      online
    ).then(setCommonsRecovery);
  }, [online, replica.gatewayBase, replica.scopes, replica.vaultId]);

  useEffect(refresh, [refresh]);

  const act = useCallback(
    async (id: string, action: () => Promise<unknown>): Promise<void> => {
      setBusyId(id);
      try {
        await action();
        refresh();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyId(undefined);
      }
    },
    [refresh]
  );

  const redeem = useCallback(
    (claim: CommonsInviteClaim): void => {
      const base = replica.gatewayBase;
      const actorVaultId = replica.vaultId;
      if (!base || !actorVaultId) return;
      void act("commons:claim", () =>
        claimCommonsInvitation(
          base,
          actorVaultId,
          claim.stewardVaultId,
          claim.claimToken
        )
      );
    },
    [act, replica.gatewayBase, replica.vaultId]
  );

  // A tapped `centraid://commons-invite` lands here carrying the claim
  // (`deep-links.ts`). It WAITS for the vault: a cold launch reaches this
  // screen before the replica is mounted, and redeeming into no vault is how
  // the claim used to get dropped. The moment it is spent, the token leaves
  // navigation state — nothing persisted or restored may replay a one-time
  // secret, and the ref makes the send itself happen exactly once.
  useEffect(() => {
    const stewardVaultId = route.params?.stewardVaultId;
    const claimToken = route.params?.claimToken;
    if (!stewardVaultId || !claimToken) return;
    if (!replica.gatewayBase || !replica.vaultId) return;
    if (spentClaims.current.has(claimToken)) return;
    spentClaims.current.add(claimToken);
    redeem({ stewardVaultId, claimToken });
    navigation.setParams({
      stewardVaultId: undefined,
      claimToken: undefined,
    });
  }, [navigation, redeem, replica.gatewayBase, replica.vaultId, route.params]);

  const snapshots =
    edges.state === "read"
      ? edges.rows.filter((edge) => edge.mode === "snapshot")
      : [];
  const linkRows = links.state === "read" ? links.rows : [];
  // A grant this seat already re-founded has a live successor, and a steward
  // this device simply cannot reach (`link-down`) proves nothing — neither is
  // a concern to put in front of the owner.
  const recoveryConcerns = commonsRecovery.rows.filter(
    (entry) =>
      !entry.supersededBy &&
      (entry.steward.presence === "degraded" ||
        entry.steward.presence === "absent" ||
        entry.steward.presence === "parked")
  );
  const offered = commonsInvitations.rows.filter(
    (row) => row.status === "pending"
  );

  return (
    <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <Tappable
          accessibilityLabel="Back"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Tappable>
        <View style={styles.headerCopy}>
          <Text style={[t("title"), { color: colors.text }]}>
            People &amp; circles
          </Text>
          {links.state === "read" ? (
            <Text style={[t("small"), { color: colors.textSoft }]}>
              {linkRows.length} {linkRows.length === 1 ? "person" : "people"}
            </Text>
          ) : null}
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {errorMessage ? (
          <Text style={[t("small"), { color: colors.danger }]}>
            {errorMessage}
          </Text>
        ) : null}

        {recoveryConcerns.length || commonsRecovery.missed.length ? (
          <Section title="Shared-space recovery" colors={colors}>
            <Absent
              read={commonsRecovery}
              noun="Shared spaces"
              colors={colors}
            />
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
                  <Text style={[t("small"), { color: colors.textFaint }]}>
                    {entry.sourceLabel}
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
              // Discard the raw one-time secret as soon as it is handed to the
              // authenticated claim request; never log or persist it.
              setCommonsInviteCode("");
              redeem(claim);
            }}
            style={[styles.pill, { borderColor: colors.line }]}
          >
            <Text style={[t("control"), { color: colors.accent }]}>Redeem</Text>
          </Pressable>
        </Section>

        {offered.length || commonsInvitations.missed.length ? (
          <Section title="Shared spaces offered to you" colors={colors}>
            <Absent
              read={commonsInvitations}
              noun="Shared spaces offered to you"
              colors={colors}
            />
            {offered.map((row) => (
              <View
                key={`${row.sourceVaultId}:${row.invitationId}`}
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
                <Text style={[t("small"), { color: colors.textFaint }]}>
                  {row.sourceLabel}
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
                          void act(busyKey, () =>
                            answerCommonsInvitation(
                              replica.gatewayBase!,
                              row.invitationId,
                              row.sourceVaultId,
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
          {edges.state === "absent" ? (
            <Text style={[t("small"), { color: colors.textSoft }]}>
              {shareAbsentLine("Copies between your vaults", edges.reach)}
            </Text>
          ) : snapshots.length ? (
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
                    {vaultLabel(edge.audienceVaultId, linkRows)}
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
          {links.state === "absent" ? (
            <Text style={[t("small"), { color: colors.textSoft }]}>
              {shareAbsentLine("Who is linked", links.reach)}
            </Text>
          ) : linkRows.length ? (
            linkRows.map((link) => (
              <SharingLinkRow
                key={link.linkId}
                link={link}
                busy={busyId === link.linkId}
                colors={colors}
                label={vaultLabel(link.remoteVaultId ?? link.vaultB, linkRows)}
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

/** What a multi-scope section could not look at. Silent when every mounted
 *  vault answered — absence is only ever drawn from an observed failure. */
function Absent({
  read,
  noun,
  colors,
}: {
  read: ScopedShareRead<unknown>;
  noun: string;
  colors: ReturnType<typeof useTheme>["colors"];
}): React.JSX.Element | null {
  if (!read.missed.length || !read.reach) return null;
  return (
    <Text style={[t("small"), { color: colors.textSoft }]}>
      {read.rows.length
        ? sharePartialLine(read.missed)
        : shareAbsentLine(noun, read.reach)}
    </Text>
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
