import React from "react";
import { Pressable, View } from "react-native";

// THE §8 CONSENT GATE — GENERIC TWO-PANEL RENDERER (#712, native). A PURE
// VIEW: every answer leaves through a callback. ONE FILLED ELEMENT (§18): the
// on-device answer; the net answer is OUTLINED, never filled.
import type {
  AnswerAvailability,
  ConsentFact,
  ConsentPanelCopy,
  EnrichDomain,
} from "@centraid/blueprints/apps/_shared/consent-gate";

import { useTheme } from "../theme";
import { styles } from "./ConsentGate.styles";
import { Text } from "./NativeText";

export interface ConsentGateProps {
  /** The `enrich_policy` domain (#712); Locker has no value here — a type
   *  error, not a policy. */
  domain: EnrichDomain;
  onDevicePanel: ConsentPanelCopy;
  /** Live title override; falls back to `onDevicePanel.title`. */
  onDeviceTitle?: string;
  onDevice: AnswerAvailability;
  /** The bordered `net` panel — outlined, never filled, and never absent. */
  netPanel: ConsentPanelCopy;
  net: AnswerAvailability;
  note: string;
  /** A write is in flight; neither answer is takeable while it is. */
  busy?: boolean;
  /** Latched once answered. */
  answered?: "device" | "declined" | null;
  onRunOnDevice: () => void;
  onDecline: () => void;
  /** Absent while the action cannot be taken from here. */
  onChooseNet?: () => void;
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
            // Egress fact: a 2px `net` rule, never a fill or red dot (§18).
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
        // Bordered in `net`: the panel IS the egress disclosure.
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

export function ConsentGate({
  domain,
  onDevicePanel,
  onDeviceTitle,
  onDevice,
  netPanel,
  net,
  note,
  busy,
  answered,
  onRunOnDevice,
  onDecline,
  onChooseNet,
}: ConsentGateProps): React.JSX.Element {
  const { colors } = useTheme();
  const deviceReady = onDevice.available && !busy && !answered;
  const netReady = net.available && !busy && !answered && !!onChooseNet;
  return (
    <View accessibilityLabel={`${domain} consent`}>
      <Panel copy={onDevicePanel} colors={colors} title={onDeviceTitle}>
        {onDevice.reason ? (
          <Text style={[styles.unavailable, { color: colors.textSoft }]}>
            {onDevice.reason}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Pressable
            accessibilityLabel={onDevicePanel.action}
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
              {onDevicePanel.action}
            </Text>
          </Pressable>
          {onDevicePanel.action2 ? (
            <Pressable
              accessibilityLabel={onDevicePanel.action2}
              accessibilityRole="button"
              accessibilityState={{ disabled: !!busy }}
              disabled={!!busy}
              {...(busy ? {} : { onPress: onDecline })}
              style={[styles.action, { borderColor: colors.line }]}
            >
              <Text style={[styles.actionText, { color: colors.text }]}>
                {onDevicePanel.action2}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </Panel>

      <Panel copy={netPanel} colors={colors}>
        {net.reason ? (
          <Text style={[styles.unavailable, { color: colors.textSoft }]}>
            {net.reason}
          </Text>
        ) : null}
        <View style={styles.actions}>
          {/* Outlined in `net`, never filled, NEVER ABSENT: `onPress` only
              when the callback exists — no handler on a disabled control. */}
          <Pressable
            accessibilityLabel={netPanel.action}
            accessibilityRole="button"
            accessibilityState={{ disabled: !netReady }}
            disabled={!netReady}
            {...(netReady && onChooseNet ? { onPress: onChooseNet } : {})}
            style={[styles.action, { borderColor: colors.net }]}
          >
            <Text
              style={[
                styles.actionText,
                { color: netReady ? colors.net : colors.textDisabled },
              ]}
            >
              {netPanel.action}
            </Text>
          </Pressable>
        </View>
      </Panel>

      <Text style={[styles.note, { color: colors.textFaint }]}>{note}</Text>
    </View>
  );
}
