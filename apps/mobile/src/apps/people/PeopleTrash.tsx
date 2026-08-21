// Trash (v12 handoff § 9) — the 30 days a trashed person is still restorable.
//
// THERE IS NO "EMPTY TRASH" VERB. Destruction happens on the schedule the
// purge date announces and nowhere else, so this screen offers exactly one
// commit per row — `Restore` — and closes with the sentence that says when
// the rest happens. A row whose `purge_at` the vault did not state carries no
// meta: inventing "30 days left" would be this screen answering for it.

import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { daysUntil } from "@centraid/blueprints/apps/people/format";
import {
  APP_TITLE,
  EMPTY,
  FRAGMENTS,
  SENTENCES,
  VERBS,
} from "@centraid/blueprints/apps/people/people-copy";

import SkeletonRows from "../../kit/components/SkeletonRows";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { pageMargin, spacing } from "../../kit/theme";
import type { PeopleScreenProps } from "../../navigation";
import { usePeopleWrites } from "./people-writes";
import { BackRow, Caption, EmptyLine, PersonRow, Verb } from "./PeopleKit";
import PeopleScreen from "./PeopleScreen";
import { usePeople } from "./usePeople";

export default function PeopleTrash({
  navigation,
}: PeopleScreenProps<"PeopleTrash">): React.JSX.Element {
  const data = usePeople();
  const writes = usePeopleWrites(() =>
    navigation.navigate("Settings", { screen: "Approvals" })
  );

  return (
    <PeopleScreen current="people">
      <TopSafeArea edges={[]} style={styles.page}>
        <View style={styles.body}>
          <BackRow
            destination={APP_TITLE}
            onPress={() => navigation.goBack()}
          />
          {data.loading ? (
            <SkeletonRows rows={4} accessibilityLabel="Reading the trash" />
          ) : data.trash.length === 0 ? (
            // Past the loading gate an empty trash is a fact, and a good one:
            // one line, never a first-run pitch.
            <EmptyLine text={EMPTY.trash} />
          ) : (
            <ScrollView contentContainerStyle={styles.scroll}>
              {data.trash.map((person, index) => (
                <PersonRow
                  key={person.party_id}
                  avatar={person}
                  name={person.name}
                  {...(person.role ? { sub: person.role } : {})}
                  {...(person.purge_at
                    ? { meta: FRAGMENTS.daysLeft(daysUntil(person.purge_at)) }
                    : {})}
                  trailing={
                    <Verb
                      label={VERBS.restore}
                      onPress={() => void writes.restorePerson(person)}
                    />
                  }
                  last={index === data.trash.length - 1}
                />
              ))}
              <Caption text={SENTENCES.trashPurge} />
            </ScrollView>
          )}
        </View>
      </TopSafeArea>
    </PeopleScreen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: pageMargin },
  page: { flex: 1 },
  scroll: { paddingBottom: spacing[6] },
});
