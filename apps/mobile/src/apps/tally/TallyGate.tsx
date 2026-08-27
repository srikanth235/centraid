// THE DENIED GATE (§6, "Denied gate"), and the rule it exists to keep.
//
// DAY ONE AND DENIED LOOK NOTHING ALIKE (STATES.md, rule 1). Day one offers a
// first move; denied shows an absence with a RECEIPT behind it — when the
// grant went, what it covered, that nothing was deleted, and that the other
// members still hold their own copies of the facts. An app that drew one
// emptiness for both would be telling a member their ledger was empty when it
// was merely out of reach.
//
// THE CLOCK IS A FACT THE DENIAL CARRIED, so it is stated; a denial that
// carried none says so instead of inventing a time. Both sentences are §6's,
// and the choice between them is the only decision this file makes.

import React, { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import type { VaultDenied } from "@centraid/blueprints/apps/tally/types";
import {
  DENIED_BODY,
  DENIED_FACT_LABELS,
  DENIED_MEMBERS,
  DENIED_REGRANT,
  DENIED_SCOPE,
  DENIED_TITLE,
  REVOKED_UNKNOWN,
  revokedAt,
} from "@centraid/blueprints/apps/tally/view-copy";

import { Text } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { clockAt } from "./tally-view-model";
import { FieldRow } from "./TallyParts";

export interface TallyGateProps {
  denied: VaultDenied;
}

/** The receipt line: when the grant went, or that the time went with it. */
export function revocationLine(denied: VaultDenied): string {
  const at = denied.revoked_at ? clockAt(denied.revoked_at) : null;
  return at === null ? REVOKED_UNKNOWN : revokedAt(at);
}

export default function TallyGate({
  denied,
}: TallyGateProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.card}>
        <Text style={styles.title}>{DENIED_TITLE}</Text>
        <Text style={styles.body}>{DENIED_BODY}</Text>
        <View style={styles.facts}>
          <FieldRow
            label={DENIED_FACT_LABELS.receipt}
            value={revocationLine(denied)}
            {...(denied.message ? { note: denied.message } : {})}
          />
          <FieldRow label={DENIED_FACT_LABELS.scope} value={DENIED_SCOPE} />
          <FieldRow label={DENIED_FACT_LABELS.members} value={DENIED_MEMBERS} />
        </View>
        <Text style={styles.regrant}>{DENIED_REGRANT}</Text>
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: {
      ...t("small"),
      color: colors.textSoft,
      paddingHorizontal: spacing[4],
    },
    card: {
      borderColor: colors.net,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      gap: spacing[2],
      paddingBottom: spacing[3],
      paddingTop: spacing[4],
    },
    facts: { marginTop: spacing[2] },
    page: { padding: spacing[4] },
    regrant: {
      ...t("small"),
      color: colors.text,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
    title: {
      ...t("title"),
      color: colors.text,
      paddingHorizontal: spacing[4],
    },
  });
