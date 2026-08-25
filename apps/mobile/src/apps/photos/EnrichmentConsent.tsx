import React from "react";
import { Pressable, ScrollView, View } from "react-native";

// THE ENRICHMENT CONSENT SURFACE, NATIVE (v4 handoff §8). A surface, not a
// row, for a privacy reason: one tap on a summary row could start enrichment
// without the member ever learning where it runs or that photographs can
// leave the device at all — this screen is the only place the product says
// so. Header chrome around the shared §8 gate (`ConsentGate`, #712); copy is
// the SAME module the web client renders, so the two clients cannot drift.
// A PURE VIEW: no state, no reads, no writes; every answer leaves through a
// callback. The gate lives in PhotosLibrary.tsx.
import {
  CLOUD_PANEL,
  ENRICHMENT_NOTE,
  ENRICHMENT_STATUS_LINE,
  ENRICHMENT_TITLE,
  ON_DEVICE_PANEL,
  onDeviceTitle,
} from "@centraid/blueprints/apps/photos/enrichment-consent";
import type { AnswerAvailability } from "@centraid/blueprints/apps/photos/enrichment-consent";

import { ConsentGate } from "../../kit/components/ConsentGate";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useTheme } from "../../kit/theme";
import { styles } from "./EnrichmentConsent.styles";

export interface EnrichmentConsentProps {
  /** Photographs the question is about; `null` when unknown — the title then says "these photographs" rather than inventing a number. */
  count: number | null;
  onDevice: AnswerAvailability;
  cloud: AnswerAvailability;
  /** A write is in flight; neither answer is takeable while it is. */
  busy?: boolean;
  /** Latched once answered, so the question stops offering itself. */
  answered?: "device" | "declined" | null;
  onRunOnDevice: () => void;
  onDecline: () => void;
  /** Absent while no cloud helper can be chosen — see `CLOUD_ANSWER` in the shared module. */
  onChooseCloud?: () => void;
  onClose: () => void;
}

export default function EnrichmentConsent({
  count,
  onDevice,
  cloud,
  busy,
  answered,
  onRunOnDevice,
  onDecline,
  onChooseCloud,
  onClose,
}: EnrichmentConsentProps): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Close face detection consent"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.headerBtn}
        >
          <Icon name="chevron-left" size={24} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>
          {ENRICHMENT_TITLE}
        </Text>
        {/* NO app-bar primary here (prototype 4799) — the only commits are the answers in the panels. */}
        <View style={styles.headerBtn} />
      </View>
      {/* Status line: what is true of this vault right now, before the answer. */}
      <Text style={[styles.status, { color: colors.textFaint }]}>
        {ENRICHMENT_STATUS_LINE}
      </Text>
      <ScrollView contentContainerStyle={styles.content}>
        <ConsentGate
          domain="photos"
          onDevicePanel={ON_DEVICE_PANEL}
          onDeviceTitle={count == null ? undefined : onDeviceTitle(count)}
          onDevice={onDevice}
          netPanel={CLOUD_PANEL}
          net={cloud}
          note={ENRICHMENT_NOTE}
          busy={busy}
          answered={answered}
          onRunOnDevice={onRunOnDevice}
          onDecline={onDecline}
          onChooseNet={onChooseCloud}
        />
      </ScrollView>
    </TopSafeArea>
  );
}
