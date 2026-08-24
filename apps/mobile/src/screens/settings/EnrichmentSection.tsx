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

// Settings → Enrichment (#807) — what the phone can SAY about
// the effective enrichment policy, which is: what it is, and nothing else.
//
// READ ONLY, DELIBERATELY. Editing the policy cascade means choosing a scope,
// a capability, an engine profile, and (for anything that leaves the member's
// own machines) answering an egress consent question. That ceremony is a
// desktop surface in this wave; a phone toggle that wrote one level of it
// would be the member changing a rule they cannot see the cascade for.
//
// WHY IT IS HERE ANYWAY. "Which of my photos and documents does Centraid look
// at, with what, and where does that work happen" is a question a member asks
// on the device the photographs were taken on. Answering it read-only costs
// nothing and closes the gap where the phone knew less about the vault than
// the vault did.
//
// EVERY WORD BELOW IS THE GATEWAY'S ANSWER. The rows render
// `GET /_vault/enrich/effective` joined to the listed engine profiles; when
// the gateway cannot be reached the section says so (docs/mobile-offline.md's
// rule: an unavailable state, never a fabricated one), because a policy read
// from a cache is a claim about what is happening right now that nothing
// re-checked.

/** Member-facing name of each domain. */
const DOMAIN_LABELS: Readonly<Record<EnrichDomain, string>> = {
  docs: "Documents",
  photos: "Photos",
};

/**
 * Member-facing name of each capability. The registry's ids are contract keys
 * (`ocr`, `doc-entities`); nobody's settings screen should show them.
 */
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

/**
 * Where the work happens, in the member's words. The axis is the engine's
 * computed egress class (`packages/server/src/enrich/engine-profiles.ts`) —
 * the member's own gateway is inside their trust domain, a provider is not.
 */
const EGRESS_WORDS: Readonly<Record<EnrichEgressClass, string>> = {
  gateway: "on your gateway",
  "on-device": "on this device",
  provider: "sent to a provider",
};

/**
 * The same axis as a CEILING, used only when the gateway named a profile it
 * did not list: the ceiling is the most the runtime would permit, so it is
 * worded as a limit rather than as a fact about where work runs.
 */
const CEILING_WORDS: Readonly<Record<EnrichEgressCeiling, string>> = {
  gateway: "no further than your gateway",
  off: "nothing runs",
  "on-device": "no further than this device",
  provider: "may be sent to a provider",
};

/** When the work is offered, in the member's words. */
const TRIGGER_WORDS: Readonly<Record<EnrichTrigger, string>> = {
  "on-demand": "when you ask",
  "on-ingest": "as items arrive",
  "on-view": "when you open an item",
};

/** What the gateway answered, or why it could not. */
type Load =
  | { kind: "loading" }
  | { kind: "ready"; states: readonly EnrichCapabilityState[] }
  /** `reason` is the underlying failure, stated rather than smoothed over. */
  | { kind: "unavailable"; reason: string };

export interface EnrichmentSectionProps {
  /**
   * The read behind the section. Defaults to the gateway client; a caller
   * passes its own only in tests, which is why there is no other prop — every
   * word on screen comes from what this returns.
   */
  read?: () => Promise<EnrichCapabilityState[]>;
}

/** The one line under a capability's name: what it does, and where. */
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
