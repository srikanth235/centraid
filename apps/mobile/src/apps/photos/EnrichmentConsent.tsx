import React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

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
// Now: two panels shown BEFORE anything runs, then the note. The copy is the
// web app's copy — literally the same module
// (`@centraid/blueprints/apps/photos/enrichment-consent`) — so the two
// clients cannot drift on a promise about a member's photographs.
//
// A PURE VIEW: it holds no state, reads nothing and writes nothing. Every
// answer leaves through a callback, so "can an enrichment write be issued
// without an explicit answer" is a question about this file's props. The gate
// lives in PhotosLibrary.tsx.
//
// ONE FILLED ELEMENT (§18): `Run on this device`. `Not now` is plain and the
// cloud action is OUTLINED in `net` — egress and destructive ink are never a
// fill.
import {
  CLOUD_PANEL,
  ENRICHMENT_NOTE,
  ENRICHMENT_STATUS_LINE,
  ENRICHMENT_TITLE,
  ON_DEVICE_PANEL,
  onDeviceTitle,
} from "@centraid/blueprints/apps/photos/enrichment-consent";
import type {
  AnswerAvailability,
  ConsentFact,
  ConsentPanelCopy,
} from "@centraid/blueprints/apps/photos/enrichment-consent";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
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

function Facts({
  facts,
  colors,
}: {
  facts: readonly ConsentFact[];
  colors: ReturnType<typeof useTheme>["colors"];
}): React.JSX.Element {
  return (
    <View>
      {facts.map((fact) => (
        <View
          key={fact.label}
          style={[
            styles.fact,
            { borderBottomColor: colors.line },
            // The egress fact carries a 2px `net` rule on its leading edge and
            // nothing else — never a fill, never a red dot (§18).
            fact.net
              ? { borderLeftColor: colors.net, borderLeftWidth: 2 }
              : null,
            fact.net ? styles.factFlagged : null,
          ]}
        >
          <Text style={[styles.factLabel, { color: colors.textSoft }]}>
            {fact.label}
          </Text>
          <Text style={[styles.factValue, { color: colors.text }]}>
            {fact.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Panel({
  copy,
  title,
  colors,
  children,
}: {
  copy: ConsentPanelCopy;
  title?: string;
  colors: ReturnType<typeof useTheme>["colors"];
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View
      style={[
        styles.panel,
        { backgroundColor: colors.bgElev, borderColor: colors.line },
        // The cloud panel's whole box is bordered in `net`: the panel IS the
        // egress disclosure, so the mark belongs to the panel.
        copy.net ? { borderColor: colors.net } : null,
      ]}
    >
      <Text style={[styles.eyebrow, { color: colors.textSoft }]}>
        {copy.eyebrow}
      </Text>
      <Text style={[styles.panelTitle, { color: colors.text }]}>
        {title ?? copy.title}
      </Text>
      <Text style={[styles.body, { color: colors.textSoft }]}>{copy.body}</Text>
      <Facts facts={copy.facts} colors={colors} />
      {children}
    </View>
  );
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
  const deviceReady = onDevice.available && !busy && !answered;
  const cloudReady = cloud.available && !busy && !answered && !!onChooseCloud;
  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.toneMat }]}
      edges={["top"]}
    >
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
        <Panel
          copy={ON_DEVICE_PANEL}
          colors={colors}
          title={count == null ? undefined : onDeviceTitle(count)}
        >
          {onDevice.reason ? (
            <Text style={[styles.unavailable, { color: colors.textSoft }]}>
              {onDevice.reason}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityLabel={ON_DEVICE_PANEL.action}
              accessibilityRole="button"
              accessibilityState={{ disabled: !deviceReady }}
              disabled={!deviceReady}
              {...(deviceReady ? { onPress: onRunOnDevice } : {})}
              style={[
                styles.action,
                styles.filled,
                {
                  backgroundColor: deviceReady
                    ? colors.accentFill
                    : colors.bgSunken,
                },
              ]}
            >
              <Text
                style={[
                  styles.actionText,
                  { color: deviceReady ? colors.textInv : colors.textDisabled },
                ]}
              >
                {ON_DEVICE_PANEL.action}
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel={ON_DEVICE_PANEL.action2 ?? "Not now"}
              accessibilityRole="button"
              accessibilityState={{ disabled: !!busy }}
              disabled={!!busy}
              {...(busy ? {} : { onPress: onDecline })}
              style={[styles.action, { borderColor: colors.line }]}
            >
              <Text style={[styles.actionText, { color: colors.text }]}>
                {ON_DEVICE_PANEL.action2}
              </Text>
            </Pressable>
          </View>
        </Panel>

        <Panel copy={CLOUD_PANEL} colors={colors}>
          {cloud.reason ? (
            <Text style={[styles.unavailable, { color: colors.textSoft }]}>
              {cloud.reason}
            </Text>
          ) : null}
          <View style={styles.actions}>
            {/* Outlined in `net`, never filled, and NEVER ABSENT: a member who
                cannot take this option still has to be told what it would
                cost. `onPress` is the callback or nothing — a disabled control
                that still carries a handler is one edit away from firing. */}
            <Pressable
              accessibilityLabel={CLOUD_PANEL.action}
              accessibilityRole="button"
              accessibilityState={{ disabled: !cloudReady }}
              disabled={!cloudReady}
              {...(cloudReady && onChooseCloud
                ? { onPress: onChooseCloud }
                : {})}
              style={[styles.action, { borderColor: colors.net }]}
            >
              <Text
                style={[
                  styles.actionText,
                  { color: cloudReady ? colors.net : colors.textDisabled },
                ]}
              >
                {CLOUD_PANEL.action}
              </Text>
            </Pressable>
          </View>
        </Panel>

        <Text style={[styles.note, { color: colors.textFaint }]}>
          {ENRICHMENT_NOTE}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
