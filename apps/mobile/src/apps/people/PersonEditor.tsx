import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { agoLabel } from "@centraid/blueprints/apps/people/format";
import {
  APP_TITLE,
  CADENCE_CHIPS,
  CADENCE_NEVER,
  FIELDS,
  LABELS,
  VERBS,
} from "@centraid/blueprints/apps/people/people-copy";
import { IDENTITY_HUE_KEYS } from "@centraid/design";
import type { ColorKey } from "@centraid/design";

import Button from "../../kit/components/Button";
import ChipsBlock from "../../kit/components/ChipsBlock";
import { Text } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import TopSafeArea from "../../kit/components/TopSafeArea";
import {
  borders,
  pageMargin,
  radii,
  spacing,
  t,
  useTheme,
} from "../../kit/theme";
import type { PeopleScreenProps } from "../../navigation";
import { storedHueValue } from "./people-model";
import { usePeopleWrites } from "./people-writes";
import { BackRow, Commits, FieldRow } from "./PeopleKit";
import PeopleScreen from "./PeopleScreen";
import { usePeople } from "./usePeople";

const CADENCE_OPTIONS = CADENCE_CHIPS.map((days) => ({
  id: String(days),
  label: days === 0 ? CADENCE_NEVER : agoLabel(days),
}));

export default function PersonEditor({
  navigation,
  route,
}: PeopleScreenProps<"PersonEditor">): React.JSX.Element {
  const { colors } = useTheme();
  const partyId = route.params?.personId ?? null;
  const data = usePeople();
  const writes = usePeopleWrites(() =>
    navigation.navigate("Settings", { screen: "Approvals" })
  );

  const existing = partyId
    ? (data.people.find((row) => row.party_id === partyId) ?? null)
    : null;

  const [draft, setDraft] = useState<{
    name: string;
    role: string;
    avatar_color: string | null;
    cadence_days: number;
  } | null>(
    partyId ? null : { name: "", role: "", avatar_color: null, cadence_days: 0 }
  );

  const seeded =
    draft ??
    (existing
      ? {
          name: existing.name,
          role: existing.role,
          avatar_color: existing.avatar_color,
          cadence_days: existing.cadence_days,
        }
      : null);

  const patch = (part: Partial<NonNullable<typeof draft>>): void => {
    if (!seeded) return;
    setDraft({ ...seeded, ...part });
  };

  const save = async (): Promise<void> => {
    if (!seeded || !seeded.name.trim()) return;
    const landed = await writes.savePerson(
      {
        party_id: partyId,
        name: seeded.name.trim(),
        role: seeded.role,
        avatar_color: seeded.avatar_color,
        cadence_days: seeded.cadence_days,
      },
      existing
        ? {
            name: existing.name,
            role: existing.role,
            avatar_color: existing.avatar_color,
            cadence_days: existing.cadence_days,
          }
        : null
    );
    if (landed) navigation.goBack();
  };

  return (
    <PeopleScreen current="people">
      <TopSafeArea edges={[]} style={styles.page}>
        <View style={styles.body}>
          <BackRow
            destination={existing?.name ?? APP_TITLE}
            onPress={() => navigation.goBack()}
          />
          {seeded ? (
            <ScrollView contentContainerStyle={styles.scroll}>
              <FieldRow
                label={FIELDS.name}
                value={seeded.name}
                onChange={(name) => patch({ name })}
              />
              <FieldRow
                label={FIELDS.role}
                value={seeded.role}
                placeholder={FIELDS.rolePlaceholder}
                onChange={(role) => patch({ role })}
              />

              <Text
                style={[
                  t("annotLabel"),
                  styles.fieldLabel,
                  { color: colors.textSoft },
                ]}
              >
                {FIELDS.colour}
              </Text>
              <View
                accessibilityLabel={FIELDS.colour}
                accessibilityRole="radiogroup"
                style={styles.swatches}
              >
                {IDENTITY_HUE_KEYS.map((key: ColorKey) => {
                  const value = storedHueValue(key);
                  const on = seeded.avatar_color === value;
                  const fill =
                    colors[
                      `c${key.slice(0, 1).toUpperCase()}${key.slice(1)}`
                    ] ?? colors.accent;
                  return (
                    <Pressable
                      key={key}
                      accessibilityRole="radio"
                      accessibilityLabel={LABELS.colour(key)}
                      accessibilityState={{ selected: on }}
                      onPress={() => patch({ avatar_color: value })}
                      style={{
                        backgroundColor: fill,
                        borderColor: on ? colors.text : "transparent",
                        borderRadius: radii.pill,
                        borderWidth: 2 * borders.hairline,
                        height: 40,
                        width: 40,
                      }}
                    />
                  );
                })}
              </View>

              <Text
                style={[
                  t("annotLabel"),
                  styles.fieldLabel,
                  { color: colors.textSoft },
                ]}
              >
                {FIELDS.cadence}
              </Text>
              <ChipsBlock
                accessibilityLabel={FIELDS.cadence}
                chips={CADENCE_OPTIONS.map((option) => ({
                  id: option.id,
                  label: option.label,
                  on: option.id === String(seeded.cadence_days),
                  onPress: () => patch({ cadence_days: Number(option.id) }),
                }))}
              />

              <Commits>
                <Button
                  label={VERBS.save}
                  variant="primary"
                  disabled={!seeded.name.trim()}
                  onPress={() => void save()}
                />
                <Button
                  label={VERBS.cancel}
                  variant="quiet"
                  onPress={() => navigation.goBack()}
                />
              </Commits>
            </ScrollView>
          ) : (
            <SkeletonRows rows={5} accessibilityLabel="Reading this person" />
          )}
        </View>
      </TopSafeArea>
    </PeopleScreen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: pageMargin },
  fieldLabel: { paddingBottom: spacing[1], paddingTop: spacing[3] },
  page: { flex: 1 },
  scroll: { paddingBottom: spacing[6] },
  swatches: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    paddingBottom: spacing[2],
  },
});
