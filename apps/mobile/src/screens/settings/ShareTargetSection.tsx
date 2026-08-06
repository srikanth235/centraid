// Settings → Where your shares go (issue #712, A1) — the mobile home for the
// share-target pointer `kit/share/share-target.ts` persists. Web already has
// this choice (the desktop/PWA Sharing shelf resolves
// `window.centraid.shareTargetVaultId`); the phone had nowhere to set it at
// all, so every phone share used to ask fresh, per item
// (`AudiencePlacementSheet`). This section is where a member states a
// default once, the same way `VaultSection` above it states presentation.
//
// THE CHOICES ARE WRITABLE, NON-PERSONAL, MOUNTED VAULTS — exactly what
// `AudiencePlacementSheet` already offers when placing one item: a read-only
// audience cannot receive a share, and the member's own vault is not
// "somewhere else" to share into. "Not set" is always offered alongside them,
// because clearing the pointer is a choice a member can make, not merely the
// absence of one.
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  hydrateShareTarget,
  writeShareTarget,
} from "../../kit/share/share-target";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import SettingsSection from "./SettingsSection";

interface Candidate {
  vaultId: string;
  label: string;
}

export default function ShareTargetSection(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const replica = useReplica();
  const [targetId, setTargetId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    void hydrateShareTarget().then((record) => {
      setTargetId(record.vaultId);
      setHydrated(true);
    });
  }, []);

  // Writable, non-personal, mounted vaults — the same audience
  // AudiencePlacementSheet already offers per item, generalised to "by
  // default". `personal === false` is the durable founding marker (issue
  // #711 item H); a scope an older gateway left unmarked is treated as the
  // member's own, so it is excluded here too.
  const candidates: Candidate[] = useMemo(
    () =>
      (replica.scopes ?? [])
        .filter((scope) => scope.personal === false && scope.role !== "read")
        .map((scope) => ({ vaultId: scope.vaultId, label: scope.label })),
    [replica.scopes]
  );

  const choose = (vaultId: string | null): void => {
    setTargetId(vaultId);
    writeShareTarget({ vaultId });
  };

  if (!hydrated) {
    return (
      <SettingsSection label="Where your shares go">
        <Text style={styles.hint}>Loading…</Text>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection label="Where your shares go">
      {candidates.length === 0 ? (
        <Text style={styles.hint}>
          No writable household audience is mounted here yet. An admin can
          invite members and grant a vault role from Household settings.
        </Text>
      ) : (
        <View style={styles.card}>
          <ChoiceRow
            active={targetId === null}
            colors={colors}
            label="Not set"
            styles={styles}
            onPress={() => choose(null)}
          />
          {candidates.map((candidate) => (
            <ChoiceRow
              active={targetId === candidate.vaultId}
              colors={colors}
              key={candidate.vaultId}
              label={candidate.label}
              styles={styles}
              onPress={() => choose(candidate.vaultId)}
            />
          ))}
        </View>
      )}
    </SettingsSection>
  );
}

function ChoiceRow({
  active,
  label,
  colors,
  styles,
  onPress,
}: {
  active: boolean;
  label: string;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={styles.row}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      {active ? <Icon color={colors.accent} name="Check" size={18} /> : null}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      overflow: "hidden",
    },
    hint: { ...t("small"), color: colors.textFaint },
    row: {
      alignItems: "center",
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    rowLabel: { ...t("body"), color: colors.text },
  });
