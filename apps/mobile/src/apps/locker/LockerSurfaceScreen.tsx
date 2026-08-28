// THE THREE SURFACES REACHED FROM *More* THAT ARE NOT ROUTES OF THEIR OWN —
// Import, Export and Companion — and what each of them is on THIS seat.
//
// TWO OF THEM PERFORM NOW. Import drives the gateway's staged-import workflow
// (`locker-surfaces.ts`) and Export issues the app's own `export` action
// (`locker-writes.ts`); both doors are the gateway's, both are online-only by
// construction, and neither has any representation in the durable outbox. They
// were drawn as facts plus a where-sentence while their doors lived on another
// seat; the doors are reachable from here, so the facts became surfaces.
//
// COMPANION DID NOT MOVE, AND IT IS NOT WAITING ON ANYTHING. It runs in the
// browser extension, beside the page, which is not a gap but a place. It stays
// drawn as what it IS — its lede, its facts — plus the sentence saying where the
// act happens, which is the origin-capabilities rule: no dead controls, and no
// pretending an act is available because its name is in a menu.
//
// The facts are the shared table's (`route-copy.ts`); only the where-sentence is
// this seat's, because where an act happens is exactly the fact that differs by
// seat (docs/blueprint-seats.md, "search is not one behaviour").

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

/** Which `ROUTE_TITLE` key each surface carries. */
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

  // The two export options and the gate live in the screen, not the store: a
  // lock withdraws this screen entirely (`LockerScreen.tsx` renders the wall in
  // place of its children), so there is no way for an answered gate to survive
  // one.
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

/** Companion, stated rather than performed: the candidate and fill queries are
 *  the extension's, so this screen dispatches neither. */
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
