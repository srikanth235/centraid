// Merge (v12 handoff § 10) — one person kept, one folded into them.
//
// THREE BLOCKS AND ONE SENTENCE: `Keep` is the person this screen was opened
// from, `Merge in` is the duplicate picked from every other person (the
// contract's own suspected duplicates first), and `Result` says what survives.
// The commit does not merge — it opens the modal confirm, the rule for the
// acts no reverse write can undo. After merging, the button becomes a
// disabled `Merged` and the sentence becomes `Merged.`

import React, { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { cadenceLabel } from "@centraid/blueprints/apps/people/format";
import {
  CONFIRMS,
  EMPTY,
  FIELDS,
  FRAGMENTS,
  MERGE_HEADS,
  SECTIONS,
  SENTENCES,
  VERBS,
} from "@centraid/blueprints/apps/people/people-copy";
import type { PersonRow as PersonRowModel } from "@centraid/blueprints/apps/people/types";

import Button from "../../kit/components/Button";
import SkeletonRows from "../../kit/components/SkeletonRows";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { pageMargin, spacing } from "../../kit/theme";
import type { PeopleScreenProps } from "../../navigation";
import { usePeopleWrites } from "./people-writes";
import PeopleConfirm from "./PeopleConfirm";
import {
  BackRow,
  Caption,
  Commits,
  EmptyLine,
  PeopleSection,
  PersonRow,
} from "./PeopleKit";
import PeopleScreen from "./PeopleScreen";
import { usePeople, usePerson } from "./usePeople";

/** One `Result` row: the surviving value, and what it replaced where the
 *  duplicate held something else. */
function resultRow(
  field: string,
  kept: string,
  replaced: string | undefined
): { name: string; sub: string } {
  const differs = Boolean(replaced) && replaced !== kept;
  return {
    name: kept,
    sub: differs && replaced ? FRAGMENTS.was(field, replaced) : field,
  };
}

export default function MergeView({
  navigation,
  route,
}: PeopleScreenProps<"PersonMerge">): React.JSX.Element {
  const partyId = route.params.personId;
  const data = usePeople();
  const { person: keep, loading } = usePerson(partyId);
  const writes = usePeopleWrites(() =>
    navigation.navigate("Settings", { screen: "Approvals" })
  );
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [merged, setMerged] = useState(false);

  // Everyone except the person on screen, with the contract's own suspected
  // duplicates first — a person the vault already suspects belongs at the top.
  const candidates = useMemo(() => {
    const duplicates = new Set(
      (keep?.contact ?? []).flatMap(
        (channel) => channel.duplicate_party_ids ?? []
      )
    );
    return data.people
      .filter((person) => person.party_id !== partyId)
      .sort(
        (a, b) =>
          Number(duplicates.has(b.party_id)) -
          Number(duplicates.has(a.party_id))
      );
  }, [data.people, keep, partyId]);

  const source: PersonRowModel | null =
    candidates.find((person) => person.party_id === sourceId) ?? null;

  const cadenceDays =
    keep && keep.cadence_days > 0
      ? keep.cadence_days
      : (source?.cadence_days ?? keep?.cadence_days ?? 0);
  const rows = keep
    ? [
        resultRow(FIELDS.name, keep.name, source?.name),
        resultRow(FIELDS.role, keep.role, source?.role),
        resultRow(
          FIELDS.colour,
          keep.avatar_color ?? source?.avatar_color ?? "",
          source?.avatar_color ?? undefined
        ),
        resultRow(
          FIELDS.cadence,
          cadenceLabel(cadenceDays),
          source ? cadenceLabel(source.cadence_days) : undefined
        ),
      ].filter((row) => row.name)
    : [];

  return (
    <PeopleScreen current="people">
      <TopSafeArea edges={[]} style={styles.page}>
        <View style={styles.body}>
          <BackRow
            destination={keep?.name ?? "Person"}
            onPress={() => navigation.goBack()}
          />
          {keep ? (
            <ScrollView contentContainerStyle={styles.scroll}>
              <PeopleSection title={MERGE_HEADS.keep}>
                <PersonRow
                  avatar={keep}
                  name={keep.name}
                  {...(keep.role ? { sub: keep.role } : {})}
                  last
                />
              </PeopleSection>

              <PeopleSection
                title={MERGE_HEADS.mergeIn}
                count={candidates.length}
              >
                {candidates.length === 0 ? (
                  <EmptyLine text={EMPTY.merge} />
                ) : (
                  candidates.map((candidate, index) => (
                    <PersonRow
                      key={candidate.party_id}
                      avatar={candidate}
                      name={candidate.name}
                      {...(candidate.role ? { sub: candidate.role } : {})}
                      // Selection is the row's own meta word — a weight change
                      // alone does not survive the phone's smaller rungs, and
                      // the shared row carries no selected state to borrow.
                      {...(candidate.party_id === sourceId
                        ? { meta: "✓" }
                        : {})}
                      onOpen={() =>
                        setSourceId((current) =>
                          current === candidate.party_id
                            ? null
                            : candidate.party_id
                        )
                      }
                      last={index === candidates.length - 1}
                    />
                  ))
                )}
              </PeopleSection>

              <PeopleSection title={SECTIONS.result}>
                {rows.map((row, index) => (
                  <PersonRow
                    key={row.sub}
                    name={row.name}
                    sub={row.sub}
                    last={index === rows.length - 1}
                  />
                ))}
              </PeopleSection>

              <Caption
                text={merged ? SENTENCES.merged : SENTENCES.mergeWarning}
              />

              <Commits>
                <Button
                  label={merged ? VERBS.merged : VERBS.merge}
                  variant="destructive"
                  disabled={merged || !source}
                  onPress={() => setConfirming(true)}
                />
                <Button
                  label={VERBS.cancel}
                  variant="quiet"
                  onPress={() => navigation.goBack()}
                />
              </Commits>
            </ScrollView>
          ) : loading ? (
            <SkeletonRows rows={5} accessibilityLabel="Reading this person" />
          ) : (
            <EmptyLine text={EMPTY.noMatch} />
          )}
        </View>
      </TopSafeArea>
      <PeopleConfirm
        visible={confirming && !!source && !!keep}
        title={CONFIRMS.merge.title(source?.name ?? "", keep?.name ?? "")}
        body={CONFIRMS.merge.body}
        verb={CONFIRMS.merge.verb}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          if (!source || !keep) return;
          void writes
            .mergePeople(source, { party_id: partyId, name: keep.name })
            .then((landed) => {
              if (landed) setMerged(true);
            });
        }}
      />
    </PeopleScreen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: pageMargin },
  page: { flex: 1 },
  scroll: { paddingBottom: spacing[6] },
});
