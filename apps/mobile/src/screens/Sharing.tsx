// Who this vault is linked to, and the ceremony that adds one more.
//
// Reaching another person is ONE mechanism: an approved vault link. The people
// a link produced are what every share sheet offers as an audience, so this
// screen has exactly two parts — mint or redeem a ticket, and read the roster
// that ceremony writes.

import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { SHARING_CHANGE_NOT_SAVED } from "@centraid/client/sharing-copy";
import { RETRY_ACTION } from "@centraid/client/surface-copy";

import { Text } from "../kit/components/NativeText";
import { useReplica } from "../kit/replica/ReplicaProvider";
import { PushedPage } from "../kit/rooms";
import { TEST_IDS } from "../kit/test-ids";
import { pageMargin, spacing, t, useTheme } from "../kit/theme";
import { approveLink, listLinks } from "../lib/replica/links-transport";
import type { GatewayLink } from "../lib/replica/links-transport";
import type { SettingsScreenProps } from "../navigation";
import {
  readShareSection,
  SHARE_READ_LOADING,
  shareAbsentLine,
} from "./sharing-reads";
import type { ShareRead } from "./sharing-reads";
import SharingLinkRow, { LinkTicketPanel } from "./SharingLinkRow";
import { useShellParent } from "./shell-places";

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
  const [links, setLinks] =
    useState<ShareRead<GatewayLink>>(SHARE_READ_LOADING);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [busyId, setBusyId] = useState<string>();

  const online = replica.online;

  const refresh = useCallback((): void => {
    const base = replica.gatewayBase;
    if (!base) return;
    // A refusal and an unreachable gateway are different answers, and neither
    // of them is `[]` — an empty roster must only ever mean an empty roster.
    void readShareSection(() => listLinks(base), online).then(setLinks);
  }, [online, replica.gatewayBase]);

  useEffect(refresh, [refresh]);

  const act = useCallback(
    async (id: string, action: () => Promise<unknown>): Promise<void> => {
      setBusyId(id);
      try {
        await action();
        refresh();
      } catch (error) {
        console.warn("[sharing] change failed", error);
        setErrorMessage(`${SHARING_CHANGE_NOT_SAVED} ${RETRY_ACTION}`);
      } finally {
        setBusyId(undefined);
      }
    },
    [refresh]
  );

  const linkRows = links.state === "read" ? links.rows : [];
  const backTo = useShellParent();

  return (
    <PushedPage
      backTo={backTo}
      onBack={() => navigation.goBack()}
      testID={TEST_IDS.sharing.screen}
      title="People and circles"
    >
      <ScrollView contentContainerStyle={styles.body}>
        {errorMessage ? (
          <Text style={[t("small"), { color: colors.danger }]}>
            {errorMessage}
          </Text>
        ) : null}

        <Section title="Link with someone" colors={colors}>
          <LinkTicketPanel
            vaultId={replica.vaultId}
            colors={colors}
            gatewayBase={replica.gatewayBase}
            onLinked={refresh}
          />
        </Section>

        <Section
          title="People"
          colors={colors}
          testID={TEST_IDS.sharing.people}
        >
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
    </PushedPage>
  );
}

function Section({
  title,
  colors,
  children,
  testID,
}: {
  title: string;
  colors: ReturnType<typeof useTheme>["colors"];
  children: React.ReactNode;
  /** A handle from `kit/test-ids`, on the sections a flow has to find. */
  testID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.section} testID={testID}>
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
  body: { gap: spacing[4], padding: pageMargin, paddingBottom: spacing[6] },
  section: { gap: 8 },
  sectionTitle: { letterSpacing: 0.6 },
});
