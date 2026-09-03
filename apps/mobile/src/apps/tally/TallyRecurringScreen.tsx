import React from "react";
import { ScrollView, StyleSheet } from "react-native";

import {
  COMPOSE_OUTCOMES,
  DUE_OCCURRENCE,
  NO_PREVIEW,
  OFFLINE_MATERIALISE,
  RECURRING_EMPTY,
  RECURRING_META,
  RECURRING_SECTIONS,
  RECURRING_VERBS,
  TEMPLATE_UNSAVEABLE,
  UNSUMMARISABLE,
} from "@centraid/blueprints/apps/tally/compose-copy";
import { metaSentence, money } from "@centraid/blueprints/apps/tally/format";
import {
  dueNext,
  scheduleSentence,
  statusChip,
  templateSaveBase,
} from "@centraid/blueprints/apps/tally/schedule-model";
import { RECURRING } from "@centraid/blueprints/apps/tally/shelves";
import {
  editOccurrenceWrite,
  materializeWrite,
  saveRecurringWrite,
} from "@centraid/blueprints/apps/tally/writes";

import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { spacing, t, useTheme } from "../../kit/theme";
import type { TallyScreenProps } from "../../navigation";
import { issueTallyWrite, materializeOccurrence } from "./tally-writes";
import { LedgerRow, Section } from "./TallyParts";
import TallyScreen from "./TallyScreen";
import { useTallyVault } from "./useTallyVault";

export default function TallyRecurringScreen({
  navigation,
}: TallyScreenProps<"TallyRecurring">): React.JSX.Element {
  const { colors } = useTheme();
  const vault = useTallyVault();
  const replica = useReplica();
  const templates = vault.dashboard.recurring;
  const due = dueNext(templates, vault.now);

  return (
    <TallyScreen
      current="more"
      shelf={RECURRING}
      onBack={() => navigation.goBack()}
    >
      <ScrollView contentContainerStyle={styles.page}>
        <Section
          label={RECURRING_SECTIONS.templates}
          meta={RECURRING_META.templates}
          empty={RECURRING_EMPTY.templates}
          filled={templates.length > 0}
        >
          {templates.map((template) => {
            const sentence = scheduleSentence(template);
            const base = templateSaveBase(template);
            const paused = template.status === "paused";
            return (
              <LedgerRow
                key={template.template_id}
                title={template.description}
                meta={metaSentence([
                  sentence ?? NO_PREVIEW,
                  template.time_zone,
                  money(
                    template.original_amount_minor,
                    template.original_currency
                  ),
                  base ? "" : TEMPLATE_UNSAVEABLE,
                ])}
                {...(statusChip(template)
                  ? { chip: statusChip(template), chipTone: "seam" as const }
                  : {})}
                {...(base
                  ? {
                      act: {
                        label: paused
                          ? RECURRING_VERBS.resume
                          : RECURRING_VERBS.pause,
                        onPress: () =>
                          void issueTallyWrite(
                            replica.session,
                            saveRecurringWrite({
                              ...base,
                              status: paused ? "active" : "paused",
                            }),
                            {
                              executed: paused
                                ? COMPOSE_OUTCOMES.resumed
                                : COMPOSE_OUTCOMES.paused,
                            }
                          ),
                      },
                    }
                  : {})}
              />
            );
          })}
        </Section>
        {templates.some((template) => scheduleSentence(template) === null) ? (
          <Text style={[styles.note, { color: colors.textFaint }]}>
            {UNSUMMARISABLE}
          </Text>
        ) : null}

        <Section
          label={RECURRING_SECTIONS.due}
          meta={RECURRING_META.due}
          empty={RECURRING_EMPTY.due}
          filled={due.length > 0}
        >
          {due.map((occurrence) => (
            <LedgerRow
              key={`${occurrence.templateId}-${occurrence.originalStart}`}
              title={occurrence.description}
              meta={metaSentence([
                occurrence.when,
                money(occurrence.amountMinor, occurrence.currency),
                DUE_OCCURRENCE,
              ])}
              figure={{
                netMinor: occurrence.amountMinor,
                text: money(occurrence.amountMinor, occurrence.currency),
                tone: "settled",
              }}
              act={
                replica.online
                  ? {
                      label: RECURRING_VERBS.materialise,
                      onPress: () =>
                        void materializeOccurrence(
                          replica.session,
                          replica.online,
                          materializeWrite(
                            occurrence.templateId,
                            occurrence.originalStart
                          ),
                          COMPOSE_OUTCOMES.materialised
                        ),
                    }
                  : {
                      label: RECURRING_VERBS.skip,
                      onPress: () =>
                        void issueTallyWrite(
                          replica.session,
                          editOccurrenceWrite({
                            action: "skip",
                            originalStart: occurrence.originalStart,
                            scope: "occurrence",
                            templateId: occurrence.templateId,
                          }),
                          { executed: COMPOSE_OUTCOMES.skipped }
                        ),
                    }
              }
            />
          ))}
        </Section>
        {replica.online ? null : (
          <Text style={[styles.note, { color: colors.net }]}>
            {OFFLINE_MATERIALISE}
          </Text>
        )}
      </ScrollView>
    </TallyScreen>
  );
}

const styles = StyleSheet.create({
  note: {
    ...t("mono"),
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  page: { paddingBottom: spacing[6] },
});
