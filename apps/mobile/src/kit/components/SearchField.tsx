// THE ONE SEARCH FIELD (#1015, S4).
//
// The audit found eight hand-rolled search fields across nine surfaces: five
// placements, three keyboard contracts, four ways of saying how many matched,
// and one that had no way to clear the term at all. None of that is a product
// difference — the words differ per app, and nothing else does.
//
// The keyboard contract is Locker's, which is the only one that was fully
// right: `autoCapitalize="none"` and `autoCorrect={false}` (a search term is
// not prose, and a capitalised or auto-corrected term silently searches for
// something the member did not type), `returnKeyType="search"`, and
// `keyboardShouldPersistTaps` left to the list that owns the results.
//
// Props:
//  - `value` / `onChangeText` — controlled, always; a search field with its
//    own state is a field whose term and results can disagree.
//  - `onSubmit` — the return key. Omitted means the field searches as it types.
//  - `placeholder` — the app's own words; also the accessibility label, unless
//    `accessibilityLabel` overrides it.
//  - `count` — the result line under the field, already worded by the caller
//    ("12 matched"). Omitted means no line. It is NOT the no-match state:
//    that is an `EmptyBlock` in the routine register, which the list renders.
//  - `onClear` — optional extra work when the member clears (dropping results,
//    for instance); the term is cleared through `onChangeText` regardless.
//
// Adoption is per app and not done here: this exports the field, and each
// app's own wave replaces its hand-rolled one.

import React, { useMemo } from "react";
import { Pressable, View } from "react-native";

import { useTheme } from "../theme";
import Icon from "./Icon";
import { Text, TextInput } from "./NativeText";
import { styles } from "./SearchField.styles";

export interface SearchFieldProps {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  /** The return key. Omitted: the field searches as it types. */
  onSubmit?: (term: string) => void;
  /** Extra work when the term is cleared; the term clears either way. */
  onClear?: () => void;
  /** The caller's own result line, e.g. `12 matched`. */
  count?: string;
  /** Overrides the placeholder as the spoken label. */
  accessibilityLabel?: string;
  /** The word on the clear control, for VoiceOver. */
  clearLabel?: string;
}

export default function SearchField({
  value,
  onChangeText,
  placeholder,
  onSubmit,
  onClear,
  count,
  accessibilityLabel,
  clearLabel = "Clear the search",
}: SearchFieldProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(
    () => ({
      count: { color: colors.textFaint },
      field: {
        backgroundColor: colors.bgElev,
        borderColor: colors.line,
      },
      input: { color: colors.text },
    }),
    [colors]
  );

  const clear = (): void => {
    onChangeText("");
    onClear?.();
  };

  return (
    <View>
      <View style={styles.row}>
        <View style={[styles.field, ink.field]}>
          <Icon name="search" size={16} color={colors.textFaint} />
          <TextInput
            accessibilityLabel={accessibilityLabel ?? placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={onChangeText}
            {...(onSubmit
              ? { onSubmitEditing: () => onSubmit(value) }
              : undefined)}
            placeholder={placeholder}
            placeholderTextColor={colors.textFaint}
            returnKeyType="search"
            style={[styles.input, ink.input]}
            value={value}
          />
          {/* The control appears only with something to clear: an always-on
              clear is a control that refuses most of the time. */}
          {value.length > 0 ? (
            <Pressable
              accessibilityLabel={clearLabel}
              accessibilityRole="button"
              onPress={clear}
              style={styles.clear}
            >
              <Icon name="x-circle" size={16} color={colors.textFaint} />
            </Pressable>
          ) : null}
        </View>
      </View>
      {count ? <Text style={[styles.count, ink.count]}>{count}</Text> : null}
    </View>
  );
}
