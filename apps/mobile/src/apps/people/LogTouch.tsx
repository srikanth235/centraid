// Log a touch (v12 handoff § Screens 5) — the app's most repeated act.
//
// ONE SCREEN, THREE DECISIONS, NO SCROLLING: who it was about (stated, not
// chosen), what kind it was, and an optional note. Saving stamps
// last-contacted, prepends the touch to Touch → Recent, and reports
// `<Kind> logged · <name>` on the frame's status line — with NO Undo, because
// nothing in the contract un-logs an interaction (`people-writes.ts`).

import React, { useState } from "react";
import { StyleSheet, View } from "react-native";

import { whenLabel } from "@centraid/blueprints/apps/people/format";
import {
  FIELDS,
  LOG_KINDS,
  VERBS,
} from "@centraid/blueprints/apps/people/people-copy";

import Button from "../../kit/components/Button";
import ChipsBlock from "../../kit/components/ChipsBlock";
import SkeletonRows from "../../kit/components/SkeletonRows";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { pageMargin, spacing } from "../../kit/theme";
import type { PeopleScreenProps } from "../../navigation";
import { usePeopleWrites } from "./people-writes";
import { BackRow, Commits, FieldRow, PersonRow } from "./PeopleKit";
import PeopleScreen from "./PeopleScreen";
import { usePeople } from "./usePeople";

export default function LogTouch({
  navigation,
  route,
}: PeopleScreenProps<"PersonLog">): React.JSX.Element {
  const partyId = route.params.personId;
  const data = usePeople();
  const writes = usePeopleWrites(() =>
    navigation.navigate("Settings", { screen: "Approvals" })
  );
  // The chip's word IS the word the vault stores (`people-copy.ts`).
  const [kind, setKind] = useState<string>(LOG_KINDS[0]);
  const [text, setText] = useState("");

  const person = data.people.find((row) => row.party_id === partyId) ?? null;

  const save = async (): Promise<void> => {
    if (!person) return;
    const landed = await writes.logTouch(
      { party_id: partyId, kind, text: text.trim() },
      person.name
    );
    if (landed) navigation.goBack();
  };

  return (
    <PeopleScreen current="touch">
      <TopSafeArea edges={[]} style={styles.page}>
        <View style={styles.body}>
          <BackRow
            destination={person?.name ?? "Person"}
            onPress={() => navigation.goBack()}
          />
          {data.loading && !person ? (
            <SkeletonRows rows={3} accessibilityLabel="Reading this person" />
          ) : person ? (
            <>
              <PersonRow
                avatar={person}
                name={person.name}
                sub={whenLabel(person.last_contacted_at ?? person.created_at)}
                subNumeric
                last
              />
              <View style={styles.gap}>
                <ChipsBlock
                  accessibilityLabel="Kind"
                  chips={LOG_KINDS.map((option) => ({
                    id: option,
                    label: option,
                    on: option === kind,
                    onPress: () => setKind(option),
                  }))}
                />
              </View>
              <FieldRow
                label={FIELDS.note}
                value={text}
                placeholder={FIELDS.notePlaceholder}
                onChange={setText}
              />
              <Commits>
                <Button
                  label={VERBS.log}
                  variant="primary"
                  onPress={() => void save()}
                />
                <Button
                  label={VERBS.cancel}
                  variant="quiet"
                  onPress={() => navigation.goBack()}
                />
              </Commits>
            </>
          ) : null}
        </View>
      </TopSafeArea>
    </PeopleScreen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: pageMargin },
  gap: { paddingTop: spacing[3] },
  page: { flex: 1 },
});
