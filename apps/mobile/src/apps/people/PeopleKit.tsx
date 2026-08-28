// People's native recipes — the phone mirror of blueprints' people Shared.tsx;
// ONE ROW AND ONE SECTION for the whole app, every string the caller's.
//
// THE LINK RING (v12): solid ink where linked, dashed line-colour where not,
// NOTHING where the sharing plane could not be read. A wrapper View border
// (`outline` does not exist in React Native) reserving the same outer rectangle
// in all three states, so a row cannot reflow when link facts arrive.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { LABELS } from "@centraid/blueprints/apps/people/people-copy";
import { identityInitials, identityInk } from "@centraid/design";
import type { ColorKey } from "@centraid/design";

import Button from "../../kit/components/Button";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { avatarFill } from "./people-model";

export type LinkRing = "linked" | "unlinked" | "unknown";

/** Star mark: 17px on a 24 grid, stroke 1.5 (the handoff's path). */
const STAR_PATH =
  "M12 3.8l2.6 5.2 5.7.9-4.1 4 1 5.7-5.2-2.8-5.2 2.8 1-5.7-4.1-4 5.7-.9z";

/** Avatar boxes and ring rungs; fixed sizes. */
const AVATAR_ROW = 34;
const AVATAR_HERO = 52;
const RING_ROW = { width: 1.5, offset: 2 } as const;
const RING_HERO = { width: 2, offset: 3 } as const;

export interface AvatarSubject {
  party_id: string;
  name: string;
  avatar_color?: string | null;
}

export function PersonAvatar({
  person,
  link = "unknown",
  hero = false,
}: {
  person: AvatarSubject;
  link?: LinkRing;
  hero?: boolean;
}): React.JSX.Element {
  const { colors } = useTheme();
  const ring = hero ? RING_HERO : RING_ROW;
  const box = hero ? AVATAR_HERO : AVATAR_ROW;
  const fill = avatarFill(
    person,
    (key: ColorKey) =>
      colors[`c${key.slice(0, 1).toUpperCase()}${key.slice(1)}`] ??
      colors.accent
  );
  const ink = identityInk(fill, colors.text, colors.textInv);
  const outer = box + 2 * (ring.offset + ring.width);
  return (
    <View
      style={{
        alignItems: "center",
        justifyContent: "center",
        width: outer,
        height: outer,
        borderRadius: radii.pill,
        borderWidth: ring.width,
        // Unknown draws NOTHING — never paint a dashed ring and call it
        // "not linked" (transparent border keeps the outer box).
        borderColor:
          link === "linked"
            ? colors.text
            : link === "unlinked"
              ? colors.line
              : "transparent",
        borderStyle: link === "unlinked" ? "dashed" : "solid",
      }}
    >
      <View
        style={{
          alignItems: "center",
          justifyContent: "center",
          width: box,
          height: box,
          borderRadius: radii.pill,
          backgroundColor: fill,
        }}
      >
        <Text
          style={[hero ? t("bodyStrong") : t("smallStrong"), { color: ink }]}
        >
          {identityInitials(person.name)}
        </Text>
      </View>
    </View>
  );
}

/** Its own 44×44 target — pressing never opens the person. */
export function StarButton({
  name,
  starred,
  disabled = false,
  disabledHint,
  onToggle,
}: {
  name: string;
  starred: boolean;
  disabled?: boolean;
  disabledHint?: string;
  onToggle: () => void;
}): React.JSX.Element {
  const { colors, targetMin } = useTheme();
  const label = starred ? LABELS.unstar(name) : LABELS.star(name);
  const stroke = disabled
    ? colors.textDisabled
    : starred
      ? colors.text
      : colors.textFaint;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: starred }}
      accessibilityHint={disabled ? disabledHint : undefined}
      disabled={disabled}
      onPress={() => {
        if (disabled) return;
        onToggle();
      }}
      style={{
        alignItems: "center",
        justifyContent: "center",
        width: targetMin.coarse,
        height: targetMin.coarse,
        borderRadius: radii.md,
      }}
    >
      <Svg width={17} height={17} viewBox="0 0 24 24" fill="none">
        <Path
          d={STAR_PATH}
          stroke={stroke}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={starred && !disabled ? colors.text : "none"}
        />
      </Svg>
    </Pressable>
  );
}

export interface PersonRowProps {
  avatar?: AvatarSubject;
  avatarLink?: LinkRing;
  name: string;
  sub?: string;
  subNumeric?: boolean;
  meta?: string;
  metaNet?: boolean;
  pending?: string;
  /** Wrap the name instead of ellipsising (notes row). */
  wrap?: boolean;
  onOpen?: () => void;
  trailing?: React.ReactNode;
  star?: React.ReactNode;
  /** No bottom rule — the section's last row. */
  last?: boolean;
}

/** THE ROW: avatar · main · meta · verbs · star, everywhere. */
export function PersonRow(props: PersonRowProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const body = (
    <>
      <Text
        style={[styles.rowName, props.wrap ? undefined : styles.oneLine]}
        {...(props.wrap ? {} : { numberOfLines: 1 })}
      >
        {props.name}
      </Text>
      {props.sub ? (
        <Text
          numberOfLines={1}
          style={[styles.rowSub, props.subNumeric ? styles.numeric : undefined]}
        >
          {props.sub}
        </Text>
      ) : null}
      {props.pending ? (
        <Text numberOfLines={1} style={styles.rowPending}>
          {props.pending}
        </Text>
      ) : null}
    </>
  );
  return (
    <View style={[styles.row, props.last ? styles.rowLast : undefined]}>
      {props.avatar ? (
        <PersonAvatar
          person={props.avatar}
          link={props.avatarLink ?? "unknown"}
        />
      ) : null}
      {props.onOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={LABELS.openPerson(props.name)}
          onPress={props.onOpen}
          style={styles.rowMain}
        >
          {body}
        </Pressable>
      ) : (
        <View style={styles.rowMain}>{body}</View>
      )}
      {props.meta ? (
        <Text
          numberOfLines={1}
          style={[
            styles.rowMeta,
            { color: props.metaNet ? colors.net : colors.textFaint },
          ]}
        >
          {props.meta}
        </Text>
      ) : null}
      {props.trailing}
      {props.star}
    </View>
  );
}

/** A trailing verb, or its quiet twin for a removal. */
export function Verb({
  label,
  quiet = false,
  disabled = false,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  quiet?: boolean;
  disabled?: boolean;
  /** Supply where the visible word does not name its object ("✕"). */
  accessibilityLabel?: string;
  onPress: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  if (quiet) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        style={{
          alignItems: "center",
          justifyContent: "center",
          minWidth: 44,
          minHeight: 44,
          paddingHorizontal: spacing[2],
        }}
      >
        <Text
          style={[
            t("smallStrong"),
            { color: disabled ? colors.textDisabled : colors.textSoft },
          ]}
        >
          {label}
        </Text>
      </Pressable>
    );
  }
  return (
    <Button
      label={label}
      onPress={onPress}
      disabled={disabled}
      variant="secondary"
      {...(accessibilityLabel ? { accessibilityHint: accessibilityLabel } : {})}
    />
  );
}

export interface PeopleSectionProps {
  title: string;
  /** Rows inside; omitted rather than shown as an invented zero. */
  count?: number;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  /** The head's own `Add`, for in-place adds. */
  add?: React.ReactNode;
  children: React.ReactNode;
}

/** THE SECTION: head (title, count, collapse, Add) then rows or empty state. */
export function PeopleSection(props: PeopleSectionProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const open = props.open ?? true;
  const head = (
    <>
      <Text numberOfLines={1} style={styles.sectionTitle}>
        {props.title}
      </Text>
      {props.count === undefined ? null : (
        <Text numberOfLines={1} style={styles.sectionMeta}>
          {props.count}
        </Text>
      )}
      {props.collapsible ? (
        <Text style={styles.sectionCaret}>{open ? "−" : "+"}</Text>
      ) : null}
    </>
  );
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        {props.collapsible && props.onToggle ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={LABELS.collapse(props.title)}
            accessibilityState={{ expanded: open }}
            onPress={props.onToggle}
            style={styles.sectionHeadMain}
          >
            {head}
          </Pressable>
        ) : (
          <View style={styles.sectionHeadMain}>{head}</View>
        )}
        {props.add}
      </View>
      {open ? props.children : null}
    </View>
  );
}

/** A section's one-sentence empty state. */
export function EmptyLine({ text }: { text: string }): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Text
      style={[
        t("body"),
        { color: colors.textSoft, paddingVertical: spacing[2] },
      ]}
    >
      {text}
    </Text>
  );
}

/** A screen's closing sentence — the trash's purge line. */
export function Caption({ text }: { text: string }): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Text
      style={[
        t("annotLabel"),
        { color: colors.textSoft, paddingVertical: spacing[3] },
      ]}
    >
      {text}
    </Text>
  );
}

/** Commit row: both controls grow to fill on touch. */
export function Commits({
  children,
}: {
  children: React.ReactNode | React.ReactNode[];
}): React.JSX.Element {
  const cells = Array.isArray(children) ? children : [children];
  return (
    <View
      style={{
        flexDirection: "row",
        gap: spacing[2],
        paddingVertical: spacing[3],
      }}
    >
      {cells.map((cell, index) => (
        // Position is identity: a fixed pair, never reordered.
        <View key={index} style={{ flex: 1 }}>
          {cell}
        </View>
      ))}
    </View>
  );
}

/** Labelled input — the handoff's `field` at control height. */
export function FieldRow({
  label,
  value,
  placeholder,
  onChange,
  trailing,
  autoFocus,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  trailing?: React.ReactNode;
  autoFocus?: boolean;
}): React.JSX.Element {
  const { colors, targetMin } = useTheme();
  return (
    <View style={{ gap: spacing[1], paddingVertical: spacing[1] }}>
      <Text style={[t("annotLabel"), { color: colors.textSoft }]}>{label}</Text>
      <View
        style={{ alignItems: "center", flexDirection: "row", gap: spacing[2] }}
      >
        <TextInput
          accessibilityLabel={label}
          autoFocus={autoFocus}
          value={value}
          placeholder={placeholder}
          placeholderTextColor={colors.textFaint}
          onChangeText={onChange}
          style={[
            t("body"),
            {
              borderColor: colors.line,
              borderRadius: radii.md,
              borderWidth: borders.hairline,
              color: colors.text,
              flex: 1,
              minHeight: targetMin.coarse,
              paddingHorizontal: spacing[3],
            },
          ]}
        />
        {trailing}
      </View>
    </View>
  );
}

/** Vault tag under the hero: `<name> · <label>` on sunken paper. */
export function VaultTag({ label }: { label: string }): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.bgSunken,
        borderColor: colors.line,
        borderRadius: radii.pill,
        borderWidth: borders.hairline,
        justifyContent: "center",
        minHeight: 28,
        paddingHorizontal: spacing[2],
      }}
    >
      <Text style={[t("small"), { color: colors.text }]}>{label}</Text>
    </View>
  );
}

/** Back row: chevron + the DESTINATION's name, never "Back". */
export function BackRow({
  destination,
  onPress,
}: {
  destination: string;
  onPress: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Back to ${destination}`}
      onPress={onPress}
      style={{
        alignItems: "center",
        flexDirection: "row",
        gap: spacing[1],
        minHeight: 40,
      }}
    >
      <Icon name="chevron-left" size={18} color={colors.textSoft} />
      <Text style={[t("smallStrong"), { color: colors.textSoft }]}>
        {destination}
      </Text>
    </Pressable>
  );
}

/** Count tiles: two-up; each filters or navigates — never a bare badge. */
export function CountTiles({
  tiles,
  onSelect,
}: {
  tiles: readonly {
    id: string;
    label: string;
    count: number;
    net?: boolean;
  }[];
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: spacing[2],
        paddingBottom: spacing[3],
      }}
    >
      {tiles.map((tile) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${tile.label} ${tile.count}`}
          key={tile.id}
          onPress={() => onSelect(tile.id)}
          style={{
            backgroundColor: colors.bgElev,
            borderColor: colors.line,
            borderRadius: radii.lg,
            borderWidth: borders.hairline,
            flexBasis: "47%",
            flexGrow: 1,
            gap: 2,
            padding: spacing[3],
          }}
        >
          <Text
            style={[
              t("display"),
              { fontVariant: t("mono").fontVariant },
              {
                color:
                  tile.net === true && tile.count > 0
                    ? colors.net
                    : colors.text,
              },
            ]}
          >
            {tile.count}
          </Text>
          <Text style={[t("annotLabel"), { color: colors.textSoft }]}>
            {tile.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    numeric: { fontVariant: t("mono").fontVariant },
    oneLine: { flexShrink: 1 },
    row: {
      alignItems: "center",
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      minHeight: 44,
      paddingVertical: spacing[2],
    },
    rowLast: { borderBottomWidth: 0 },
    rowMain: { flex: 1, gap: 2, minWidth: 0 },
    rowMeta: { ...t("annotLabel"), flexShrink: 0 },
    rowName: { ...t("labelOn"), color: colors.text },
    rowPending: { ...t("annotLabel"), color: colors.textSoft },
    rowSub: { ...t("annotLabel"), color: colors.textFaint },
    section: { paddingTop: spacing[4] },
    sectionCaret: { ...t("smallStrong"), color: colors.textSoft },
    sectionHead: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[3],
      minHeight: 44,
    },
    sectionHeadMain: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: spacing[3],
      minWidth: 0,
    },
    sectionMeta: {
      ...t("mono"),
      color: colors.textFaint,
      flexShrink: 1,
      minWidth: 0,
    },
    sectionTitle: { ...t("eyebrow"), color: colors.text, flexShrink: 0 },
  });
