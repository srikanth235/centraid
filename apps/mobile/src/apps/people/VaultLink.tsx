// Vault link (v12 handoff § 7) — the person's link standing, READ-ONLY.
//
// The handoff draws this as the SETUP screen: a composer that makes a link,
// and per-item `Revoke`. Both are writes on the sharing plane, and People
// holds only reads on it (decisions.md #821 L-write) — a link is made from a
// container, which People does not own. So this screen keeps the handoff's
// READ half in full — the hero with its ring, the vault tags, the `Linked
// vaults` rows and the `Shared with them` receipts — and draws NO composer,
// no `Link vault` verb and no `Revoke`. The handoff's two ceremony sentences
// narrate the withheld composer, so they are withheld with it
// (`INTEGRATION-NOTES.md` carries the register).
//
// NOTHING IN THE APP NAVIGATES HERE TODAY: the roster's `Link` verb and the
// person screen's `Link vault` commit are the withheld doors. The route stays
// in the frozen contract and renders the standing honestly for a deep link.

import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { whenLabel } from "@centraid/blueprints/apps/people/format";
import {
  CONTAINER_FALLBACK,
  CONTAINER_WORDS,
  EMPTY,
  LINK,
  SECTIONS,
} from "@centraid/blueprints/apps/people/people-copy";
import type {
  ShareCapability,
  SharedContainer,
} from "@centraid/blueprints/apps/people/types";

import { Text } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { pageMargin, spacing, t, useTheme } from "../../kit/theme";
import type { PeopleScreenProps } from "../../navigation";
import {
  BackRow,
  EmptyLine,
  PeopleSection,
  PersonAvatar,
  PersonRow,
  VaultTag,
} from "./PeopleKit";
import PeopleScreen from "./PeopleScreen";
import { usePerson } from "./usePeople";

function capabilityWord(capability: ShareCapability): string {
  return capability === "read+write" ? LINK.readWrite : LINK.read;
}

function sharedName(container: SharedContainer): string {
  if (container.container_label) return container.container_label;
  return CONTAINER_WORDS[container.container_type] ?? CONTAINER_FALLBACK;
}

export default function VaultLink({
  navigation,
  route,
}: PeopleScreenProps<"PersonLink">): React.JSX.Element {
  const { colors } = useTheme();
  const partyId = route.params.personId;
  const { person, loading } = usePerson(partyId);

  const vaults = person?.vaults ?? null;
  const sharedItems = person?.shared_with_them ?? null;
  const linksAvailable = person !== null && vaults !== null;
  const linked = (vaults?.length ?? 0) > 0;

  return (
    <PeopleScreen current="people">
      <TopSafeArea edges={[]} style={styles.page}>
        <View style={styles.body}>
          <BackRow
            destination={person?.name ?? "Person"}
            onPress={() => navigation.goBack()}
          />
          {person ? (
            <ScrollView contentContainerStyle={styles.scroll}>
              <View style={styles.hero}>
                <PersonAvatar
                  person={person}
                  hero
                  link={
                    linksAvailable
                      ? linked
                        ? "linked"
                        : "unlinked"
                      : "unknown"
                  }
                />
                <View style={styles.heroText}>
                  <Text
                    style={[t("title"), { color: colors.text }]}
                    numberOfLines={1}
                  >
                    {person.name}
                  </Text>
                  {person.role ? (
                    <Text style={[t("body"), { color: colors.textSoft }]}>
                      {person.role}
                    </Text>
                  ) : null}
                </View>
              </View>

              {linksAvailable ? (
                <View style={styles.tags}>
                  {linked ? (
                    (vaults ?? []).map((binding) => (
                      <VaultTag
                        key={binding.binding_id}
                        label={LINK.vaultRow}
                      />
                    ))
                  ) : (
                    <VaultTag label="Not linked" />
                  )}
                </View>
              ) : null}

              {linksAvailable ? (
                <PeopleSection
                  title="Linked vaults"
                  count={vaults?.length ?? 0}
                >
                  {(vaults?.length ?? 0) === 0 ? (
                    <EmptyLine text={EMPTY.vaults} />
                  ) : (
                    (vaults ?? []).map((binding, index) => (
                      <PersonRow
                        key={binding.binding_id}
                        name={LINK.vaultRow}
                        sub={LINK.linkedWhen(whenLabel(binding.linked_at))}
                        subNumeric
                        last={index === (vaults?.length ?? 0) - 1}
                      />
                    ))
                  )}
                </PeopleSection>
              ) : null}

              {linksAvailable ? (
                <PeopleSection
                  title={SECTIONS.shared}
                  count={sharedItems?.length ?? 0}
                >
                  {(sharedItems?.length ?? 0) === 0 ? (
                    <EmptyLine
                      text={linked ? EMPTY.shared : EMPTY.sharedUnlinked}
                    />
                  ) : (
                    (sharedItems ?? []).map((container, index) => (
                      <PersonRow
                        key={container.grant_id}
                        name={sharedName(container)}
                        sub={LINK.sharedSince(
                          capabilityWord(container.capability),
                          whenLabel(container.since)
                        )}
                        subNumeric
                        {...(container.status === "invited"
                          ? { meta: LINK.waiting, metaNet: true }
                          : {})}
                        last={index === (sharedItems?.length ?? 0) - 1}
                      />
                    ))
                  )}
                </PeopleSection>
              ) : null}
            </ScrollView>
          ) : loading ? (
            <SkeletonRows rows={4} accessibilityLabel="Reading this person" />
          ) : (
            <EmptyLine text={EMPTY.noMatch} />
          )}
        </View>
      </TopSafeArea>
    </PeopleScreen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: pageMargin },
  hero: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    paddingVertical: spacing[3],
  },
  heroText: { flex: 1, gap: 2, minWidth: 0 },
  page: { flex: 1 },
  scroll: { paddingBottom: spacing[6] },
  tags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    paddingBottom: spacing[2],
  },
});
