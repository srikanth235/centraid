// Settings → Sharing (issue #726 P6) — the People panel: per-person shares
// in and out, link propose/approve, the D9 receive setting, and the D9 ask
// surface for a parked incoming edge. Same idiom as PhoneStorage.tsx: a
// back-chevron header over a scrolling column of bordered cards.
//
// WORDING IS LOAD-BEARING (D7). Stopping a lend reads "Stop lending" — NEVER
// "take back": what the audience already read cannot be un-seen, only the
// window can close. A give is warned irrevocable in the share sheet itself,
// at share time — this screen only narrates what already happened.
//
// HONEST STATES, not failures: a parked ask waits, never errors; a borrowed
// scope's reachState renders as a state (offered/established/parked), never
// collapses to "shared" or vanishes when unreachable.
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import Icon from "../kit/components/Icon";
import { Text } from "../kit/components/NativeText";
import TopSafeArea from "../kit/components/TopSafeArea";
import { useReplica } from "../kit/replica/ReplicaProvider";
import { density, radii, t, useTheme } from "../kit/theme";
import {
  answerPendingEdge,
  closeEdge,
  listEdges,
  listPendingEdges,
} from "../lib/replica/edges-transport";
import type { GatewayEdge, PendingEdge } from "../lib/replica/edges-transport";
import { approveLink, listLinks } from "../lib/replica/links-transport";
import type { GatewayLink } from "../lib/replica/links-transport";
import type { SettingsScreenProps } from "../navigation";
import SharingLinkRow, { LinkTicketPanel } from "./SharingLinkRow";

/** The link's own record of who `vaultId` is (#726 P6 gap 3) — `labelA`/
 *  `labelB` name `vaultA`/`vaultB` symmetrically, regardless of which side is
 *  "mine". `null` when a link genuinely never recorded one. */
function labelFromLinks(
  vaultId: string,
  links: readonly GatewayLink[]
): string | null {
  for (const linkRow of links) {
    if (linkRow.vaultA === vaultId) return linkRow.labelA;
    if (linkRow.vaultB === vaultId) return linkRow.labelB;
  }
  return null;
}

/** Best label for a raw vault id: the link's own record, else a borrowed
 *  row's holder label, else an HONEST "unknown" — never a raw id standing in
 *  for a name (#726 P6 gap 3). */
function vaultLabel(
  vaultId: string,
  borrowed: readonly { vaultId: string; label: string }[],
  links: readonly GatewayLink[]
): string {
  return (
    labelFromLinks(vaultId, links) ??
    borrowed.find((entry) => entry.vaultId === vaultId)?.label ??
    "Unknown vault"
  );
}

export default function SharingScreen({
  navigation,
}: SettingsScreenProps<"Sharing">): React.JSX.Element {
  const { colors } = useTheme();
  const replica = useReplica();
  const [links, setLinks] = useState<GatewayLink[]>([]);
  const [edges, setEdges] = useState<GatewayEdge[]>([]);
  const [pending, setPending] = useState<PendingEdge[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [busyId, setBusyId] = useState<string | undefined>();

  const refresh = useCallback(() => {
    const base = replica.gatewayBase;
    if (!base) return;
    Promise.all([listLinks(base), listEdges(base), listPendingEdges(base)])
      .then(([l, e, p]) => {
        setLinks(l);
        setEdges(e);
        setPending(p);
        setErrorMessage(undefined);
      })
      .catch((error: unknown) =>
        setErrorMessage(error instanceof Error ? error.message : String(error))
      );
  }, [replica.gatewayBase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Borrowed scopes double as a fallback label source for a linked vault
  // whose link row genuinely has none (an older link, #726 P6 gap 3 — the
  // gateway now names both sides of a same-machine link at propose time).
  const borrowedLabels = (replica.scopes ?? [])
    .filter((scope) => scope.borrowed)
    .map((scope) => ({ vaultId: scope.vaultId, label: scope.label }));

  const answer = async (
    edgeId: string,
    decision: "accept" | "refuse"
  ): Promise<void> => {
    const base = replica.gatewayBase;
    if (!base) return;
    setBusyId(edgeId);
    try {
      await answerPendingEdge(base, edgeId, decision);
      refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(undefined);
    }
  };

  // The owner-facing revoke route (#726 P6 gap 1) — one door for both
  // directions: "Stop lending" at the origin, "Stop borrowing" at the
  // audience. The gateway disambiguates by which side's row this owner owns.
  const closeShare = async (edgeId: string): Promise<void> => {
    const base = replica.gatewayBase;
    if (!base) return;
    setBusyId(edgeId);
    try {
      await closeEdge(base, edgeId);
      refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(undefined);
    }
  };

  const approve = async (linkId: string): Promise<void> => {
    const base = replica.gatewayBase;
    if (!base) return;
    setBusyId(linkId);
    try {
      await approveLink(base, linkId);
      refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(undefined);
    }
  };

  const borrowed = (replica.scopes ?? []).filter((scope) => scope.borrowed);
  const liveOut = edges.filter((edge) => edge.mode === "live");

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
          <Text style={[t("title"), { color: colors.text }]}>Sharing</Text>
          <Text style={[t("small"), { color: colors.textSoft }]}>
            {links.length} {links.length === 1 ? "link" : "links"} ·{" "}
            {borrowed.length} shared with you
          </Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {errorMessage ? (
          <Text style={[t("small"), { color: colors.danger }]}>
            {errorMessage}
          </Text>
        ) : null}

        {pending.length > 0 ? (
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
                  {vaultLabel(row.peerVaultId, borrowedLabels, links)} wants to
                  share {row.itemCount} {row.itemType}
                </Text>
                <Text style={[t("small"), { color: colors.textSoft }]}>
                  Parked — nothing has been written yet.
                </Text>
                <View style={styles.rowActions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busyId === row.edgeId}
                    onPress={() => void answer(row.edgeId, "accept")}
                    style={[styles.pill, { borderColor: colors.line }]}
                  >
                    <Text style={[t("control"), { color: colors.accent }]}>
                      Accept
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busyId === row.edgeId}
                    onPress={() => void answer(row.edgeId, "refuse")}
                    style={[styles.pill, { borderColor: colors.line }]}
                  >
                    <Text style={[t("control"), { color: colors.textSoft }]}>
                      Refuse
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </Section>
        ) : null}

        <Section title="Shared with me" colors={colors}>
          {borrowed.length === 0 ? (
            <Text style={[t("small"), { color: colors.textSoft }]}>
              Nobody is lending you anything yet.
            </Text>
          ) : (
            borrowed.map((scope) => {
              const info = scope.borrowed!;
              return (
                <View
                  key={info.edgeId}
                  style={[
                    styles.card,
                    {
                      backgroundColor: colors.bgElev,
                      borderColor: colors.line,
                    },
                  ]}
                >
                  <View style={styles.rowBetween}>
                    <Text style={[t("body"), { color: colors.text }]}>
                      {info.holderLabel}
                    </Text>
                    <Text
                      style={[
                        t("control"),
                        {
                          color:
                            info.reachState === "established"
                              ? colors.success
                              : info.reachState === "parked"
                                ? colors.danger
                                : colors.textSoft,
                        },
                      ]}
                    >
                      {info.reachState}
                    </Text>
                  </View>
                  <Text style={[t("small"), { color: colors.textSoft }]}>
                    {info.itemType}
                  </Text>
                  {info.reachState === "parked" && info.reason ? (
                    <Text style={[t("small"), { color: colors.textSoft }]}>
                      At {info.holderLabel}’s vault — {info.reason}
                    </Text>
                  ) : null}
                  <Pressable
                    accessibilityLabel="Stop borrowing"
                    accessibilityRole="button"
                    disabled={busyId === info.edgeId}
                    onPress={() => void closeShare(info.edgeId)}
                    style={[styles.pill, { borderColor: colors.line }]}
                  >
                    <Text style={[t("control"), { color: colors.accent }]}>
                      Stop borrowing
                    </Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </Section>

        <Section title="What you’re lending" colors={colors}>
          {liveOut.length === 0 ? (
            <Text style={[t("small"), { color: colors.textSoft }]}>
              You aren’t lending any scope right now.
            </Text>
          ) : (
            liveOut.map((edge) => (
              <View
                key={edge.edgeId}
                style={[
                  styles.card,
                  { backgroundColor: colors.bgElev, borderColor: colors.line },
                ]}
              >
                <View style={styles.rowBetween}>
                  <Text style={[t("body"), { color: colors.text }]}>
                    {vaultLabel(edge.audienceVaultId, borrowedLabels, links)}
                  </Text>
                  <Text style={[t("control"), { color: colors.textSoft }]}>
                    {edge.status}
                  </Text>
                </View>
                <Text style={[t("small"), { color: colors.textSoft }]}>
                  {edge.itemType}
                </Text>
                <Pressable
                  accessibilityLabel="Stop lending"
                  accessibilityRole="button"
                  disabled={busyId === edge.edgeId}
                  onPress={() => void closeShare(edge.edgeId)}
                  style={[styles.pill, { borderColor: colors.line }]}
                >
                  <Text style={[t("control"), { color: colors.accent }]}>
                    Stop lending
                  </Text>
                </Pressable>
              </View>
            ))
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

        <Section title="Links" colors={colors}>
          {links.length === 0 ? (
            <Text style={[t("small"), { color: colors.textSoft }]}>
              No links yet.
            </Text>
          ) : (
            links.map((link) => (
              <SharingLinkRow
                key={link.linkId}
                link={link}
                busy={busyId === link.linkId}
                colors={colors}
                gatewayBase={replica.gatewayBase}
                label={vaultLabel(
                  link.remoteVaultId ?? link.vaultB,
                  borrowedLabels,
                  links
                )}
                onApprove={() => void approve(link.linkId)}
              />
            ))
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
