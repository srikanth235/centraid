import React, { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { manualShareSelection } from "@centraid/blueprints/apps/_shared/named-circle-selection";
import {
  nearNameMatches,
  quickAddedDestination,
} from "@centraid/blueprints/apps/_shared/share-kit";

import { Text, TextInput } from "../components/NativeText";
import { useReplica } from "../replica/ReplicaProvider";
import { nativeWriteOutput } from "../replica/write-outcome";
import { borders, radii, spacing, t, useTheme } from "../theme";
import type { NativeShareTarget } from "./share-targets";

type ShareCapability = "read" | "read+write";
type ShareSelections = Record<string, ShareCapability>;

export interface QuickAddPersonProps {
  busy: boolean;
  destinations: readonly NativeShareTarget[];
  onAdded: (next: { circleId: string; selections: ShareSelections }) => void;
  onRosterChanged: () => void;
  rosterRevision: number;
  selections: Readonly<ShareSelections>;
}

export default function QuickAddPerson({
  busy,
  destinations,
  onAdded,
  onRosterChanged,
  selections,
}: QuickAddPersonProps): React.JSX.Element {
  const { colors } = useTheme();
  const replica = useReplica();
  const [draftName, setDraftName] = useState("");
  /** Confirmation is scoped to the exact draft that raised the warning. */
  const [confirmedName, setConfirmedName] = useState("");
  const [addHint, setAddHint] = useState("");
  const [adding, setAdding] = useState(false);
  const nearMatches = nearNameMatches(destinations, draftName);
  const needsConfirm =
    nearMatches.length > 0 && confirmedName !== draftName.trim();

  const quickAdd = async (): Promise<void> => {
    const name = draftName.trim();
    if (!name || adding) return;
    if (needsConfirm) {
      setConfirmedName(name);
      setAddHint(
        `Nobody was added yet — press Add anyway again to make a second ${name}.`
      );
      return;
    }
    if (!replica.session) {
      setAddHint("This vault cannot add people right now.");
      return;
    }
    setAdding(true);
    try {
      const result = await replica.session.write("people", {
        action: "add-person",
        input: { display_name: name, cadence_days: 30 },
      });
      const partyId = String(nativeWriteOutput(result)?.party_id ?? "");
      if (result.status === "executed" && partyId) {
        const added = quickAddedDestination(partyId, name);
        onAdded(manualShareSelection(selections, added.id, "read"));
        setDraftName("");
        setConfirmedName("");
        setAddHint(`${name} was added and selected.`);
      } else if (result.status === "queued" || result.status === "in-flight") {
        // The row is visible through the overlay, but its id is not settled.
        onRosterChanged();
        setDraftName("");
        setConfirmedName("");
        setAddHint(
          `${name} is saved on this device — selectable once the gateway has them.`
        );
      } else {
        setAddHint(result.reason ?? "Could not add that person.");
      }
    } catch (error) {
      setAddHint(
        error instanceof Error ? error.message : "Could not add that person."
      );
    } finally {
      setAdding(false);
    }
  };

  return (
    <View style={styles.quickAdd}>
      <View style={styles.quickAddRow}>
        <TextInput
          accessibilityLabel="Name of someone to add"
          autoCapitalize="words"
          editable={!adding && !busy}
          onChangeText={(next) => {
            setDraftName(next);
            setAddHint("");
          }}
          placeholder="Add someone by name"
          placeholderTextColor={colors.textSoft}
          style={[
            styles.quickAddField,
            {
              backgroundColor: colors.bgElev,
              borderColor: colors.line,
              color: colors.text,
            },
          ]}
          value={draftName}
        />
        <Pressable
          accessibilityLabel={
            nearMatches.length ? "Add anyway" : "Add this person"
          }
          accessibilityRole="button"
          accessibilityState={{
            disabled: !draftName.trim() || adding || busy,
          }}
          disabled={!draftName.trim() || adding || busy}
          onPress={() => void quickAdd()}
          style={[
            styles.circlePill,
            {
              borderColor: colors.line,
              backgroundColor: draftName.trim()
                ? colors.bgElev
                : colors.bgSunken,
            },
          ]}
        >
          <Text style={{ color: colors.accent }}>
            {adding ? "Adding…" : nearMatches.length ? "Add anyway" : "Add"}
          </Text>
        </Pressable>
      </View>
      {nearMatches.length ? (
        <Text style={[t("small"), { color: colors.textSoft }]}>
          Already on this list:{" "}
          {nearMatches.map((match) => match.label).join(", ")}
        </Text>
      ) : null}
      {addHint ? (
        <Text style={[t("small"), { color: colors.textSoft }]}>{addHint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  circlePill: {
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  quickAdd: {
    gap: spacing[1],
    paddingBottom: spacing[3],
    paddingHorizontal: spacing[4],
  },
  quickAddField: {
    ...t("body"),
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    flex: 1,
    minHeight: 44,
    paddingHorizontal: spacing[3],
  },
  quickAddRow: { alignItems: "center", flexDirection: "row", gap: spacing[2] },
});
