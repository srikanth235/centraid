import React from "react";
import { Pressable, ScrollView, View } from "react-native";

// THE ENRICHMENT CONSENT SURFACE, NATIVE (v4 handoff §8, prototype
// `s==='enrich'`).
//
// What this replaced, and why it was a privacy defect rather than a styling
// gap: Library carried an `Enrichment` row whose meta read `N consent
// policies · request faces, places and metadata`, and whose ONE TAP fired
// `request-enrichment` immediately. A member could start the work without
// ever being told where it would run, what would leave the device, what would
// be written, or how to undo it — and the cloud-helper option, the only place
// the product says photographs can leave the device at all, did not exist on
// this client.
//
// Now: a header (back chevron, title, status line) around the shared §8 gate
// (`kit/components/ConsentGate.tsx`, issue #712 C1) — the panels/facts/
// actions used to be inline here, and moved so Docs' capture-time OCR consent
// (the second instance of this product law) can read the same renderer. This
// file supplies only Photos' own chrome and copy — literally the same copy
// module the web client renders
// (`@centraid/blueprints/apps/photos/enrichment-consent`), so the two clients
// cannot drift on a promise about a member's photographs.
//
// A PURE VIEW: it holds no state, reads nothing and writes nothing. Every
// answer leaves through a callback, so "can an enrichment write be issued
// without an explicit answer" is a question about this file's props. The gate
// lives in PhotosLibrary.tsx.
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
  /** How many photographs the question is about. `null` while the count is
   *  unknown — the title then asks about "these photographs" rather than
   *  inventing a number. */
  count: number | null;
  onDevice: AnswerAvailability;
  cloud: AnswerAvailability;
  /** A write is in flight; neither answer is takeable while it is. */
  busy?: boolean;
  /** Latched once answered, so the question stops offering itself. */
  answered?: "device" | "declined" | null;
  onRunOnDevice: () => void;
  onDecline: () => void;
  /** Absent while no cloud helper can be chosen — see `CLOUD_ANSWER` in the
   *  shared module. The panel renders either way. */
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
        {/* No trailing action: there is NO app-bar primary on this screen
            (prototype 4799). The only commits are the answers in the panels. */}
        <View style={styles.headerBtn} />
      </View>
      {/* The status line — what is true of this vault right now, stated before
          the question rather than after the answer. */}
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
