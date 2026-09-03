// ADD / EDIT — `locker/edit` (README-Locker §1, §3; STATES.md Locker/Add-edit).
//
// THE ONLINE-ONLY RULE IS THE LEDE, not a refusal discovered at commit. It is
// the first thing on the screen, in `EDIT_LEDE`'s own words, and the second
// sentence says what the rule does NOT cost — the star, the tags, the trash
// all still work offline.
//
// TYPE IS THE FIRST CONTROL AND IT DECIDES THE FIELDS (`draft.ts`), so a card
// is never asked for a username. Switching type keeps what the two types share
// and drops what they do not, rather than carrying a stale value invisibly to
// the payload builder.
//
// A SEALED FIELD ROUND-TRIPS AS A PLACEHOLDER. An edit pre-fills every sealed
// value with `SEALED`, which the vault reads as UNCHANGED — so a title can be
// changed without the member re-typing a password they never revealed, and the
// form never holds a secret it was not given.
//
// THE WRITE GOES THROUGH THE ONLINE-ONLY DOOR. `addItemWrite`/`editItemWrite`
// carry `onlineOnly`, and `native-session.ts` sends those straight to the
// gateway: there is no branch in which this payload reaches the outbox.
import React, { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  SEALED,
  carriesMatchPolicy,
  emptySeed,
  fieldsFor,
  isReady,
  retype,
  seedFromDetail,
} from "@centraid/blueprints/apps/locker/draft";
import {
  generate,
  defaultGenOptions,
} from "@centraid/blueprints/apps/locker/gen-model";
import {
  EDIT_CANCEL,
  EDIT_FOOT,
  EDIT_FOOT_OFFLINE,
  EDIT_HEAD_EDIT,
  EDIT_HEAD_NEW,
  EDIT_LEDE_TAIL,
  EDIT_SAVE,
  EDIT_TITLE_MISSING,
  FIELD_NOTE,
  MATCH_DOMAIN,
  MATCH_HOST,
  MATCH_NOTE_DOMAIN,
  MATCH_NOTE_HOST,
  MATCH_POLICY_ROW,
  SEALED_UNCHANGED,
  TAGS_NOTE,
  TAGS_PLACEHOLDER,
  TAGS_ROW,
  TITLE_NOTE,
  TITLE_PLACEHOLDER,
  TITLE_ROW,
  TYPE_NOTE,
  TYPE_ROW,
} from "@centraid/blueprints/apps/locker/route-copy";
import type {
  ItemDraftSeed,
  LockerItemType,
} from "@centraid/blueprints/apps/locker/types";
import {
  EDIT_LEDE,
  GENERATE,
  TYPE_LABEL,
  TYPE_ORDER,
} from "@centraid/blueprints/apps/locker/view-copy";

import Button from "../../kit/components/Button";
import ChipsBlock from "../../kit/components/ChipsBlock";
import type { ChipDef } from "../../kit/components/ChipsBlock";
import { Text, TextInput } from "../../kit/components/NativeText";
import SectionBlock from "../../kit/components/SectionBlock";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { LockerScreenProps } from "../../navigation";
import { SCAN_SEED } from "./locker-seat-copy";
import { saveLockerItem } from "./locker-writes";
import LockerScanSheet from "./LockerScanSheet";
import LockerScreen from "./LockerScreen";
import { useLockerVault } from "./useLockerVault";

export default function LockerEditScreen({
  navigation,
  route,
}: LockerScreenProps<"LockerEdit">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const replica = useReplica();
  const itemId = route.params?.itemId;
  const generated = route.params?.generated;

  // An edit seeds from the detail the item screen already opened — which is
  // the only place on this seat a `LockerDetail` exists. With none (a deep
  // link straight to the editor) the form is a new item, because seeding from
  // a read this screen never made would mean opening one without a permit.
  const opened = useLockerVault().bag.detail;
  const [seed, setSeed] = useState<ItemDraftSeed>(() => {
    if (itemId && opened?.item_id === itemId) return seedFromDetail(opened);
    const base = emptySeed("login");
    return generated
      ? { ...base, fields: { ...base.fields, password: generated } }
      : base;
  });
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const fields = fieldsFor(seed.type);
  const editing = itemId !== undefined;

  const setField = (key: string, value: string): void => {
    setSeed((current) => ({
      ...current,
      fields: { ...current.fields, [key]: value },
    }));
  };

  const typeChips: readonly ChipDef[] = TYPE_ORDER.map((type) => ({
    id: type,
    label: TYPE_LABEL[type],
    on: seed.type === type,
    onPress: () =>
      setSeed((current) => retype(current, type as LockerItemType)),
  }));

  const save = (): void => {
    if (!isReady(seed)) {
      setError(EDIT_TITLE_MISSING);
      return;
    }
    setBusy(true);
    setError("");
    void saveLockerItem(replica.session, {
      ...seed,
      ...(itemId ? { itemId, mode: "edit" as const } : {}),
    })
      .then((ok) => {
        if (ok) navigation.popTo("LockerHome", { destination: "items" });
      })
      .finally(() => setBusy(false));
  };

  return (
    <LockerScreen
      current="items"
      hideBand
      onBack={() => navigation.popTo("LockerHome", { destination: "items" })}
      route="edit"
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.head}>
          <Text accessibilityRole="header" style={styles.title}>
            {editing ? EDIT_HEAD_EDIT : EDIT_HEAD_NEW}
          </Text>
          {/* The rule, up front. Never discovered at commit. */}
          <Text style={styles.lede}>{EDIT_LEDE}</Text>
          <Text style={styles.note}>{EDIT_LEDE_TAIL}</Text>
        </View>

        <SectionBlock label={TYPE_ROW} />
        <ChipsBlock accessibilityLabel={TYPE_ROW} chips={typeChips} />
        <Text style={styles.note}>{TYPE_NOTE}</Text>

        <SectionBlock label={TITLE_ROW} />
        <TextInput
          accessibilityLabel={TITLE_ROW}
          onChangeText={(value) =>
            setSeed((current) => ({ ...current, title: value }))
          }
          placeholder={TITLE_PLACEHOLDER}
          placeholderTextColor={colors.textFaint}
          style={styles.input}
          value={seed.title}
        />
        <Text style={styles.note}>{TITLE_NOTE}</Text>

        {fields.map((field) => {
          const value = seed.fields[field.key] ?? "";
          const untouched = value === SEALED;
          return (
            <View key={field.key} style={styles.field}>
              <SectionBlock label={field.label} />
              <TextInput
                accessibilityLabel={field.label}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType={field.numeric === true ? "numeric" : "default"}
                multiline={field.kind === "long"}
                onChangeText={(next) => setField(field.key, next)}
                placeholder={untouched ? SEALED_UNCHANGED : field.label}
                placeholderTextColor={colors.textFaint}
                secureTextEntry={field.kind === "secret" && !untouched}
                style={styles.input}
                value={untouched ? "" : value}
              />
              <Text style={styles.note}>
                {untouched ? SEALED_UNCHANGED : (FIELD_NOTE[field.key] ?? "")}
              </Text>
              {field.kind === "secret" ? (
                <Button
                  label={GENERATE}
                  onPress={() =>
                    setField(field.key, generate(defaultGenOptions()))
                  }
                />
              ) : null}
              {field.kind === "otp" ? (
                <Button label={SCAN_SEED} onPress={() => setScanning(true)} />
              ) : null}
            </View>
          );
        })}

        {carriesMatchPolicy(seed.type) ? (
          <>
            <SectionBlock label={MATCH_POLICY_ROW} />
            <ChipsBlock
              accessibilityLabel={MATCH_POLICY_ROW}
              chips={[
                {
                  id: "registrable-domain",
                  label: MATCH_DOMAIN,
                  on: seed.urlMatchPolicy === "registrable-domain",
                  onPress: () =>
                    setSeed((current) => ({
                      ...current,
                      urlMatchPolicy: "registrable-domain",
                    })),
                },
                {
                  id: "exact-host",
                  label: MATCH_HOST,
                  on: seed.urlMatchPolicy === "exact-host",
                  onPress: () =>
                    setSeed((current) => ({
                      ...current,
                      urlMatchPolicy: "exact-host",
                    })),
                },
              ]}
            />
            <Text style={styles.note}>
              {seed.urlMatchPolicy === "exact-host"
                ? MATCH_NOTE_HOST
                : MATCH_NOTE_DOMAIN}
            </Text>
          </>
        ) : null}

        <SectionBlock label={TAGS_ROW} />
        <TextInput
          accessibilityLabel={TAGS_ROW}
          autoCapitalize="none"
          onChangeText={(value) =>
            setSeed((current) => ({ ...current, tags: value }))
          }
          placeholder={TAGS_PLACEHOLDER}
          placeholderTextColor={colors.textFaint}
          style={styles.input}
          value={seed.tags}
        />
        <Text style={styles.note}>{TAGS_NOTE}</Text>

        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}

        <View style={styles.acts}>
          <Button
            disabled={busy || !replica.online}
            label={EDIT_SAVE}
            onPress={save}
            variant="primary"
          />
          <Button
            label={EDIT_CANCEL}
            onPress={() =>
              navigation.popTo("LockerHome", { destination: "items" })
            }
          />
        </View>
        {/* Offline the commit is WITHHELD and this stands where it was: the
            rule again, at the moment it applies. */}
        <Text style={styles.note}>
          {replica.online ? EDIT_FOOT : EDIT_FOOT_OFFLINE}
        </Text>
      </ScrollView>

      <LockerScanSheet
        onClose={() => setScanning(false)}
        onSeed={(value) => {
          setField("otp_seed", value);
          setScanning(false);
        }}
        visible={scanning}
      />
    </LockerScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    acts: {
      flexDirection: "row",
      gap: spacing[2],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[4],
    },
    error: {
      ...t("small"),
      color: colors.net,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
    },
    field: { gap: spacing[2], paddingBottom: spacing[2] },
    head: { gap: spacing[2], padding: spacing[4] },
    input: {
      ...t("body"),
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      marginHorizontal: spacing[4],
      minHeight: 44,
      paddingHorizontal: spacing[3],
    },
    lede: { ...t("small"), color: colors.textSoft },
    note: {
      ...t("mono"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[1],
    },
    scroll: { paddingBottom: spacing[6] },
    title: { ...t("title"), color: colors.text },
  });
