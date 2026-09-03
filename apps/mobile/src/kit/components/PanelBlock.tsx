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

export type PanelFact = PanelFactData;

export interface PanelAction extends PanelActionData {
  onPress: () => void;
}

export type PanelFigure = PanelFigureData;

export interface PanelBlockProps {
  eyebrow?: string;
  title?: string;
  body?: string;
  quote?: boolean;
  figure?: PanelFigure;
  facts?: readonly PanelFact[];
  tone?: PanelTone;
  action?: PanelAction;
  action2?: PanelAction;
  accessibilityLabel?: string;
}

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
                {/* Under THIS number, not footnoted at panel foot. */}
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
