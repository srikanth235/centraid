import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { LockerScreenProps } from "../../navigation";
import {
  discardLockerImportDraft,
  loadLockerImportDrafts,
  openLockerImportDraft,
  publishLockerImportDraft,
  stageLockerImportFile,
} from "./locker-surfaces";
import { lockerFillCopy } from "./locker-view-model";
import { exportLockerVault } from "./locker-writes";
import LockerExportView from "./LockerExportView";
import LockerImportView from "./LockerImportView";
import LockerScreen from "./LockerScreen";
import { useLockerVault } from "./useLockerVault";

const ROUTE_OF = {
  export: "export",
  fill: "fill",
  import: "import",
} as const;

export default function LockerSurfaceScreen({
  navigation,
  route,
}: LockerScreenProps<"LockerSurface">): React.JSX.Element {
  const vault = useLockerVault();
  const replica = useReplica();
  const surface = route.params.surface;
  const online = replica.online;

  const [includeTrashed, setIncludeTrashed] = useState(false);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (surface === "import" && online) void loadLockerImportDrafts();
  }, [online, surface]);

  const body =
    surface === "import" ? (
      <LockerImportView
        batches={vault.importBatches}
        busy={vault.surfaceBusy}
        note={vault.importNote}
        offline={!online}
        onChoose={() => void stageLockerImportFile()}
        onDiscard={(batchId) => void discardLockerImportDraft(batchId)}
        onOpen={(batchId) => void openLockerImportDraft(batchId)}
        onPublish={(batchId) => void publishLockerImportDraft(batchId)}
        openBatchId={vault.openBatchId}
        rows={vault.bag.importRows}
      />
    ) : surface === "export" ? (
      <LockerExportView
        busy={vault.surfaceBusy}
        confirming={confirming}
        includeHistory={includeHistory}
        includeTrashed={includeTrashed}
        items={vault.rows.length}
        offline={!online}
        onAsk={() => setConfirming(true)}
        onCancel={() => setConfirming(false)}
        onOption={(option, on) => {
          if (option === "trashed") setIncludeTrashed(on);
          else setIncludeHistory(on);
        }}
        onRun={() => {
          setConfirming(false);
          void exportLockerVault(replica.session, {
            ...(includeHistory ? { includeHistory: true } : {}),
            ...(includeTrashed ? { includeTrashed: true } : {}),
          });
        }}
      />
    ) : (
      <FillFacts />
    );

  return (
    <LockerScreen
      current="more"
      hideBand
      onBack={() => navigation.popTo("LockerHome", { destination: "items" })}
      route={ROUTE_OF[surface]}
    >
      {body}
    </LockerScreen>
  );
}

function FillFacts(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const copy = lockerFillCopy();

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.head}>
        <Text accessibilityRole="header" style={styles.title}>
          {copy.title}
        </Text>
        <Text style={styles.lede}>{copy.lede}</Text>
      </View>

      {copy.facts.map((fact) => (
        <View key={fact.key} style={styles.fact}>
          <Text style={styles.factKey}>{fact.key}</Text>
          <View style={styles.factBody}>
            {fact.value ? (
              <Text style={styles.factValue}>{fact.value}</Text>
            ) : null}
            {fact.note ? (
              <Text style={styles.factNote}>{fact.note}</Text>
            ) : null}
          </View>
        </View>
      ))}

      {/* No control, and the reason in its place. */}
      <Text style={styles.where}>{copy.where}</Text>
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fact: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    factBody: { flex: 1, gap: spacing[1], minWidth: 0 },
    factKey: { ...t("eyebrow"), color: colors.textFaint, width: 92 },
    factNote: { ...t("mono"), color: colors.textFaint },
    factValue: { ...t("small"), color: colors.text },
    head: { gap: spacing[2], padding: spacing[4] },
    lede: {
      ...t("small"),
      borderRadius: radii.md,
      color: colors.textSoft,
    },
    scroll: { paddingBottom: spacing[6] },
    title: { ...t("title"), color: colors.text },
    where: {
      ...t("small"),
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      color: colors.textSoft,
      marginTop: spacing[3],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[4],
    },
  });
