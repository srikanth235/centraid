import React, { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import {
  MOBILE_ENRICH_CAPABILITIES,
  MOBILE_ENRICH_DOMAINS,
  readEnrichmentPolicy,
} from "../../lib/enrichment";
import type {
  EnrichCapabilityState,
  EnrichDomain,
  EnrichEgressCeiling,
  EnrichEgressClass,
  EnrichTrigger,
} from "../../lib/enrichment";
import SettingsSection from "./SettingsSection";

const DOMAIN_LABELS: Readonly<Record<EnrichDomain, string>> = {
  docs: "Documents",
  photos: "Photos",
};

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  "doc-entities": "Names, dates and amounts",
  "doc-filing": "Filing suggestions",
  "doc-text": "Text in documents",
  "embed-image": "Photo search",
  "embed-text": "Document search",
  faces: "Faces",
  obligations: "Dates and deadlines",
  ocr: "Text in photos",
  transcript: "Video and audio transcripts",
};

const EGRESS_WORDS: Readonly<Record<EnrichEgressClass, string>> = {
  gateway: "on your gateway",
  "on-device": "on this device",
  provider: "sent to a provider",
};

const CEILING_WORDS: Readonly<Record<EnrichEgressCeiling, string>> = {
  gateway: "no further than your gateway",
  off: "nothing runs",
  "on-device": "no further than this device",
  provider: "may be sent to a provider",
};

const TRIGGER_WORDS: Readonly<Record<EnrichTrigger, string>> = {
  "on-demand": "when you ask",
  "on-ingest": "as items arrive",
  "on-view": "when you open an item",
};

type Load =
  | { kind: "loading" }
  | { kind: "ready"; states: readonly EnrichCapabilityState[] }
  | { kind: "unavailable"; reason: string };

export interface EnrichmentSectionProps {
  read?: () => Promise<EnrichCapabilityState[]>;
}

function describeState(state: EnrichCapabilityState): string {
  const { effective, profile } = state;
  if (!effective) return "No policy your gateway can honour — this stays off.";
  if (!effective.enabled) return "Off";
  const where = profile
    ? EGRESS_WORDS[profile.egress]
    : CEILING_WORDS[effective.egressCeiling];
  const engine = profile ? profile.label : effective.profileId;
  return `${engine} · ${where} · ${TRIGGER_WORDS[effective.trigger]}`;
}

export default function EnrichmentSection({
  read = readEnrichmentPolicy,
}: EnrichmentSectionProps = {}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    read()
      .then((states) => {
        if (live) setLoad({ kind: "ready", states });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setLoad({
          kind: "unavailable",
          reason:
            error instanceof Error && error.message
              ? error.message
              : "The gateway did not answer.",
        });
      });
    return () => {
      live = false;
    };
  }, [read]);

  if (load.kind !== "ready") {
    return (
      <SettingsSection label="Enrichment">
        <Text style={styles.hint}>
          {load.kind === "loading"
            ? "Reading what your gateway would do…"
            : `${load.reason} Nothing is shown until it answers — this phone does not keep its own copy of the policy.`}
        </Text>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection label="Enrichment">
      {MOBILE_ENRICH_DOMAINS.map((domain) => (
        <View key={domain} style={styles.card}>
          <Text style={styles.domain}>{DOMAIN_LABELS[domain]}</Text>
          {MOBILE_ENRICH_CAPABILITIES[domain].map((capability) => {
            const state = load.states.find(
              (candidate) =>
                candidate.domain === domain &&
                candidate.capability === capability
            );
            const label = CAPABILITY_LABELS[capability] ?? capability;
            return (
              <View key={capability} style={styles.row}>
                <Text style={styles.title}>{label}</Text>
                <Text style={styles.help}>
                  {state
                    ? describeState(state)
                    : "Your gateway said nothing about this."}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
      <Text style={styles.note}>
        Shown here, changed on your desktop — picking an engine also means
        answering where its work may travel.
      </Text>
    </SettingsSection>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      gap: spacing[3],
      marginBottom: spacing[3],
      padding: spacing[4],
    },
    domain: { ...t("bodyStrong"), color: colors.text },
    help: { ...t("small"), color: colors.textFaint },
    hint: { ...t("small"), color: colors.textFaint },
    note: { ...t("small"), color: colors.textFaint },
    row: { gap: spacing[1] },
    title: { ...t("body"), color: colors.text },
  });
