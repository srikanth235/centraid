import React from "react";
import { Pressable, View } from "react-native";

// THE PEOPLE SHELF'S EMPTY STATE, NATIVE (ruled 2026-09-09). It replaced the
// enrichment consent surface, which claimed a power Photos does not have:
// recognition is ambient, so faces are grouped on ingest whether or not this
// screen is opened. What is left is signage plus ONE action that moves this
// library to the FRONT of the queue (sooner, never whether). Copy is the SAME
// module the web client renders, so the two clients cannot drift.
// A PURE VIEW: no state, no reads, no writes; the action leaves by callback.
import {
  ENRICHMENT_STATUS_LINE,
  PEOPLE_EMPTY_LINE,
  PRIORITISE_ACTION,
} from "@centraid/blueprints/apps/photos/enrichment-consent";
import type { AnswerAvailability } from "@centraid/blueprints/apps/photos/enrichment-consent";

import { Text } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import { styles } from "./PeopleEmptyState.styles";

export interface PeopleEmptyStateProps {
  prioritise: AnswerAvailability;
  busy?: boolean;
  prioritised?: boolean;
  onPrioritise: () => void;
}

export default function PeopleEmptyState({
  prioritise,
  busy,
  prioritised,
  onPrioritise,
}: PeopleEmptyStateProps): React.JSX.Element {
  const { colors } = useTheme();
  const inert = !prioritise.available || !!busy || !!prioritised;
  return (
    <View style={styles.block}>
      <Text style={[styles.status, { color: colors.textFaint }]}>
        {ENRICHMENT_STATUS_LINE}
      </Text>
      <Text style={[styles.line, { color: colors.textSoft }]}>
        {PEOPLE_EMPTY_LINE}
      </Text>
      {/* The refusal is read BESIDE the control, never as a tooltip (E1). */}
      {prioritise.reason ? (
        <Text style={[styles.reason, { color: colors.textFaint }]}>
          {prioritise.reason}
        </Text>
      ) : null}
      <Pressable
        accessibilityLabel={PRIORITISE_ACTION}
        accessibilityRole="button"
        accessibilityState={{ disabled: inert }}
        disabled={inert}
        onPress={inert ? undefined : onPrioritise}
        style={[styles.action, { borderColor: colors.line }]}
      >
        <Text
          style={[
            styles.actionLabel,
            { color: inert ? colors.textDisabled : colors.text },
          ]}
        >
          {PRIORITISE_ACTION}
        </Text>
      </Pressable>
    </View>
  );
}
