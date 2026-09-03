import React, { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import {
  LINK_TARGET_KINDS,
  NOTE_TARGET_ENTITY,
  linkTargetsFrom,
} from "@centraid/blueprints/apps/notes/link-targets-table";
import { groupTargets } from "@centraid/blueprints/apps/notes/powerbox";
import type { LinkTarget } from "@centraid/blueprints/apps/notes/types";
import { POWERBOX_FOOT } from "@centraid/blueprints/apps/notes/view-copy";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { useTheme } from "../../kit/theme";
import { styles } from "./NotesHome.styles";

const PROBE_DELAY_MS = 120;
const PER_KIND = 8;

export interface NotesPowerboxProps {
  open: boolean;
  term: string;
  excluded: ReadonlySet<string>;
  onTerm: (term: string) => void;
  onPick: (target: LinkTarget) => void;
  onClose: () => void;
}

export default function NotesPowerbox({
  open,
  term,
  excluded,
  onTerm,
  onPick,
  onClose,
}: NotesPowerboxProps): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const [targets, setTargets] = useState<LinkTarget[]>([]);

  const shown = open && term.trim() ? targets : [];

  useEffect(() => {
    const trimmed = term.trim();
    if (!open || !session || !trimmed) return;
    let live = true;
    const timer = setTimeout(() => {
      void Promise.allSettled(
        LINK_TARGET_KINDS.map(async (kind) => {
          const result = await session.search("notes", {
            entity: kind.entity,
            query: trimmed,
            limit: PER_KIND,
          });
          return linkTargetsFrom(
            kind,
            result.rows.map((row) => row.values),
            kind.entity === NOTE_TARGET_ENTITY ? excluded : new Set()
          );
        })
      ).then((settled) => {
        if (!live) return;
        setTargets(
          settled.flatMap((probe) =>
            probe.status === "fulfilled" ? probe.value : []
          )
        );
      });
    }, PROBE_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [excluded, open, session, term]);

  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <TopSafeArea
        accessibilityViewIsModal
        style={[styles.sheet, { backgroundColor: colors.bg }]}
      >
        <View style={styles.modalHeader}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close the link sheet"
            onPress={onClose}
            style={styles.iconButton}
          >
            <Icon name="x" size={23} color={colors.text} />
          </Pressable>
          <Text style={[styles.modalTitle, { color: colors.text }]}>
            Link to something in your vault
          </Text>
        </View>
        <View style={styles.controls}>
          <View
            style={[
              styles.search,
              { backgroundColor: colors.bgElev, borderColor: colors.line },
            ]}
          >
            <Icon name="search" size={17} color={colors.textFaint} />
            <TextInput
              accessibilityLabel="Search for a link target"
              value={term}
              onChangeText={onTerm}
              autoFocus
              placeholder="Search your vault"
              placeholderTextColor={colors.textFaint}
              style={[styles.searchInput, { color: colors.text }]}
            />
          </View>
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          {groupTargets(shown).map((group) => (
            <View key={group.app} style={styles.section}>
              <Text style={[styles.sectionTitle, { color: colors.textFaint }]}>
                {group.app}
              </Text>
              {group.targets.map((target) => (
                <Pressable
                  key={`${target.type}/${target.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Link to ${target.title}`}
                  onPress={() => onPick(target)}
                  style={[styles.row, { borderBottomColor: colors.line }]}
                >
                  <View style={styles.rowOpen}>
                    <Text style={[styles.rowName, { color: colors.text }]}>
                      {target.title}
                    </Text>
                    <Text style={[styles.rowMeta, { color: colors.textFaint }]}>
                      {target.subtitle}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ))}
        </ScrollView>
        <Text
          style={[styles.rowMeta, styles.section, { color: colors.textFaint }]}
        >
          {POWERBOX_FOOT}
        </Text>
      </TopSafeArea>
    </Modal>
  );
}
