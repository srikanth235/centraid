// PANEL — one bordered plate carrying a single thing worth reading, plus the
// facts that qualify it (#765, spec §9 `panelBlock`).
//
// Three jobs on the six operational pages, one component: the staged write on
// Notifications (eyebrow, quoted body, to/cc/from facts, two verbs), the fact
// panels on Analytics (facts only, no eyebrow and no title), and EVERY page's
// error state (`tone="net"`: what failed, what is safe, one way forward).
//
// The fact list is the reason the panel exists rather than a rows block: a
// fact has a KEY, and the key sits in a fixed column so the values line up
// down the list instead of stepping in and out with the length of the word
// beside them. The column is `metrics.keyColTouch` — the phone narrows the
// column, it never wraps the key.
//
// `tone` colours the EDGE only. `net` is the one chromatic ink in the system
// and it is a border, never a fill.

import React, { useMemo } from "react";
import { View } from "react-native";

import type { ButtonVariant } from "@centraid/design";
import type {
  PanelActionData,
  PanelFactData,
  PanelFigureData,
  PanelTone,
} from "@centraid/design/blocks";

import { useTheme } from "../theme";
import Button from "./Button";
import { Text } from "./NativeText";
import { styles } from "./PanelBlock.styles";

/**
 * `key` IS the displayed uppercase word, not a separate list identity — this
 * kit used to carry both, so the same field name meant the word on one surface
 * and a React key on the other. Fact keys are unique within a panel, so the
 * word is the identity.
 */
export type PanelFact = PanelFactData;

export interface PanelAction extends PanelActionData {
  onPress: () => void;
}

/** The one promoted fact — display type over a qualifier line. */
export type PanelFigure = PanelFigureData;

export interface PanelBlockProps {
  eyebrow?: string;
  title?: string;
  body?: string;
  /** Draw the body as quoted material — a leading rule and softer ink. Used
   *  for text the member did not write and is being asked to send. */
  quote?: boolean;
  /**
   * Promote ONE fact to display type. A page whose whole question is "did this
   * cost $2 or $200" answers it in the type scale or it does not answer it —
   * the same figure at the fact rung is one 13pt value among thirty. At most
   * one per view, on the same grounds as the one filled commit.
   */
  figure?: PanelFigure;
  facts?: readonly PanelFact[];
  tone?: PanelTone;
  /**
   * The panel's own verb, and a second quiet one beside it. Named `action` /
   * `action2` to match the shell rather than `primary` / `secondary`, which
   * read as a promise of filled ink: a panel verb is OUTLINED unless it is the
   * view's one commit, and the view's one commit almost always lives in the app
   * bar instead. This kit used to force filled ink on the first slot, so every
   * error panel drew "Try again" as a second filled control.
   */
  action?: PanelAction;
  action2?: PanelAction;
  accessibilityLabel?: string;
}

/** Identical to the shell's rule, so one panel cannot be louder on one seat. */
function panelActionVariant(action: PanelAction): ButtonVariant {
  if (action.filled === true) return "primary";
  return action.dangerous === true ? "destructive" : "secondary";
}

export default function PanelBlock({
  eyebrow,
  title,
  body,
  quote,
  figure,
  facts,
  tone = "neutral",
  action,
  action2,
  accessibilityLabel,
}: PanelBlockProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(() => {
    const edge =
      tone === "net" ? colors.net : tone === "seam" ? colors.seam : colors.line;
    return {
      body: { color: colors.textSoft },
      eyebrow: { color: colors.textFaint },
      factKey: { color: colors.textFaint },
      factNote: { color: colors.textFaint },
      factValue: { color: colors.text },
      factValueNet: { color: colors.net },
      figureQualifier: { color: colors.textSoft },
      figureValue: { color: colors.text },
      figureValueNet: { color: colors.net },
      panel: { backgroundColor: colors.bgElev, borderColor: edge },
      quote: { borderStartColor: colors.line },
      title: { color: colors.text },
    };
  }, [colors, tone]);

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[styles.panel, ink.panel]}
    >
      {eyebrow ? (
        <Text style={[styles.eyebrow, ink.eyebrow]}>{eyebrow}</Text>
      ) : null}
      {title ? (
        <Text accessibilityRole="header" style={[styles.title, ink.title]}>
          {title}
        </Text>
      ) : null}
      {body ? (
        <Text
          style={[
            styles.body,
            ink.body,
            quote === true ? styles.quote : undefined,
            quote === true ? ink.quote : undefined,
          ]}
        >
          {body}
        </Text>
      ) : null}
      {figure ? (
        <View style={styles.figure}>
          <Text style={[styles.eyebrow, ink.eyebrow]}>{figure.label}</Text>
          <Text
            style={[
              styles.figureValue,
              figure.net === true ? ink.figureValueNet : ink.figureValue,
            ]}
          >
            {figure.value}
          </Text>
          {figure.qualifier ? (
            <Text style={[styles.figureQualifier, ink.figureQualifier]}>
              {figure.qualifier}
            </Text>
          ) : null}
        </View>
      ) : null}
      {facts && facts.length > 0 ? (
        <View style={styles.facts}>
          {facts.map((fact) => (
            <View key={fact.key} style={styles.fact}>
              <Text style={[styles.factKey, ink.factKey]}>{fact.key}</Text>
              <View style={styles.factCell}>
                <Text
                  style={[
                    styles.factValue,
                    fact.net === true ? ink.factValueNet : ink.factValue,
                  ]}
                >
                  {fact.value}
                </Text>
                {/* The caveat belongs to THIS number, so it sits under it — a
                    footnote at the foot of the panel is one the reader has to
                    match back up to the figure it qualifies. */}
                {fact.note ? (
                  <Text style={[styles.factNote, ink.factNote]}>
                    {fact.note}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}
      {action || action2 ? (
        <View style={styles.actions}>
          {action ? (
            <Button
              accessibilityHint={action.hint}
              label={action.label}
              onPress={() => action.onPress()}
              variant={panelActionVariant(action)}
            />
          ) : null}
          {action2 ? (
            <Button
              accessibilityHint={action2.hint}
              label={action2.label}
              onPress={() => action2.onPress()}
              variant={panelActionVariant(action2)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
