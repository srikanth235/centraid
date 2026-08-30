import React, { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import {
  ACCESS_ENTITY,
  ACCESS_SCOPE,
  groupAnswers,
  parseAccessAnswers,
  parseLociBody,
} from "@centraid/client/access-lens";
import type {
  AccessGroup,
  AccessLocusCopy,
} from "@centraid/client/access-lens";

import { Text } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { nativeGrantWire } from "../../kit/share/grant-seat";
import { radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import SettingsSection from "./SettingsSection";

/**
 * Settings → Access: the phone's lens on the ONE dashboard, rendering
 * `@centraid/client/access-lens` (#883). The authority table comes from this
 * phone's own replica, so it answers offline; the per-locus revoke sentences
 * are the VAULT's, so an unreachable gateway leaves them absent rather than
 * invented. ABSENT IS NEVER EMPTY — a refused read says so, and is never drawn
 * as "nobody has any access".
 */
export default function AccessSection(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const answers = useReplicaQuery(
    ACCESS_SCOPE,
    useMemo(() => ({ entity: ACCESS_ENTITY, limit: 2_000 }), [])
  );
  const replica = useReplica();
  const base = replica.gatewayBase ?? "";
  const [loci, setLoci] = useState<AccessLocusCopy>({});

  useEffect(() => {
    let cancelled = false;
    if (!base) return undefined;
    void nativeGrantWire(base)
      .subjects()
      .then((body) => {
        if (!cancelled) setLoci(parseLociBody(body));
      })
      // The vault said nothing, so this seat says nothing in its place.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [base]);

  const groups = useMemo(
    () => groupAnswers(parseAccessAnswers(answers.rows)),
    [answers.rows]
  );

  return (
    <SettingsSection label="Access">
      {(answers.error ?? answers.unavailableReason) ? (
        <Text style={styles.help}>
          {`Access could not be read, so nothing here is a statement about what you have granted: ${
            answers.error ?? answers.unavailableReason
          }`}
        </Text>
      ) : (
        groups.map((group) => (
          <AccessGroupCard
            key={group.id}
            group={group}
            promise={loci[group.locus]}
            styles={styles}
          />
        ))
      )}
    </SettingsSection>
  );
}

function AccessGroupCard({
  group,
  promise,
  styles,
}: {
  group: AccessGroup;
  promise: string | undefined;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.groupLabel}>{group.title}</Text>
      {group.answers.length === 0 ? (
        <Text style={styles.help}>No standing answers here.</Text>
      ) : (
        group.answers.map((answer) => (
          <Text key={answer.authorityId} style={styles.row}>
            {`${answer.principalId} ${
              answer.decision === "declined" ? "may not" : "may"
            } ${answer.verb} ${
              answer.subjectId === ""
                ? answer.subjectType
                : `${answer.subjectType} ${answer.subjectId}`
            }`}
          </Text>
        ))
      )}
      {/* Verbatim from the vault (ruling V-locus), or nothing. */}
      {promise ? (
        <Text style={styles.help}>{`Withdrawing: ${promise}`}</Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.bgElev,
      borderRadius: radii.md,
      gap: spacing[2],
      marginBottom: spacing[3],
      padding: spacing[3],
    },
    groupLabel: { ...t("bodyStrong"), color: colors.text },
    help: { ...t("small"), color: colors.textFaint },
    row: { ...t("small"), color: colors.textSoft },
  });
