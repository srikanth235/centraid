import React, { useCallback, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  Switch,
  View,
} from "react-native";
import type { ListRenderItemInfo } from "react-native";

import type { ReplicaRow, ReplicaValue } from "@centraid/client/replica/native";

import HomeKey from "../../kit/components/HomeKey";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { postStatus, showUndoStatus } from "../../kit/components/status-line";
import TopSafeArea from "../../kit/components/TopSafeArea";
import {
  combineReplicaQueryStates,
  useReplicaQuery,
} from "../../kit/hooks/useReplicaQuery";
import FrameProbe from "../../kit/perf/FrameProbe";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  nativeWriteOutput,
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { useTheme } from "../../kit/theme";
import type { PeopleScreenProps } from "../../navigation";
import { MergePicker } from "./MergePicker";
import { styles } from "./PeopleHome.styles";
import {
  keyOfPerson,
  PEOPLE_LIST_ID,
  personItemLayout,
  PersonListRow,
} from "./PersonListRow";
import type { PersonRow } from "./PersonListRow";

type ChannelKind = "phone" | "email" | "address" | "handle";
const text = (row: ReplicaRow | undefined, key: string): string =>
  row?.[key] == null ? "" : String(row[key]);

export default function PeopleHome({
  navigation,
}: PeopleScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const profiles = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "people.profile", limit: 5000 }), [])
  );
  const partyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of profiles.rows) {
      if (typeof row.party_id === "string" && row.party_id)
        ids.add(row.party_id);
    }
    return [...ids];
  }, [profiles.rows]);
  const parties = useReplicaQuery(
    "people",
    useMemo(
      () =>
        partyIds.length === 0
          ? {
              entity: "core.party",
              where: [{ column: "party_id", op: "eq", value: "__none__" }],
              limit: 1,
            }
          : {
              entity: "core.party",
              where: [{ column: "party_id", op: "in", value: partyIds }],
              limit: Math.max(partyIds.length, 1),
            },
      [partyIds]
    )
  );
  const channels = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "social.contact_channel", limit: 10_000 }), [])
  );
  const queryState = combineReplicaQueryStates([profiles, parties, channels]);
  const [selectedId, setSelectedId] = useState<string>();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [kind, setKind] = useState<ChannelKind>("phone");
  const [label, setLabel] = useState("");
  const [channelValue, setChannelValue] = useState("");
  const [preferred, setPreferred] = useState(false);
  const [editingChannelId, setEditingChannelId] = useState<string>();
  const [mergeOpen, setMergeOpen] = useState(false);

  // Indexed, not scanned: this directory reaches ~5k profiles against a
  // same-sized party table, and the `find` this replaces made the join
  // quadratic — 25M comparisons on every render that touched either query.
  const partyNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const party of parties.rows) {
      names.set(String(party.party_id), text(party, "display_name"));
    }
    return names;
  }, [parties.rows]);
  const people = useMemo<PersonRow[]>(
    () =>
      profiles.rows
        .filter((profile) => !profile.deleted_at)
        .map(
          (profile) =>
            ({
              ...profile,
              party_id: String(profile.party_id),
              name:
                partyNames.get(String(profile.party_id)) || "Unnamed person",
            }) as PersonRow
        )
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    [partyNames, profiles.rows]
  );
  const selected =
    people.find((person) => person.party_id === selectedId) ?? people[0];
  const selectedPartyId = selected?.party_id;
  const selectedChannels = useMemo(
    () =>
      channels.rows
        .filter((channel) => channel.party_id === selectedPartyId)
        .sort(
          (a, b) =>
            Number(b.is_preferred ?? 0) - Number(a.is_preferred ?? 0) ||
            String(a.kind).localeCompare(String(b.kind))
        ),
    [channels.rows, selectedPartyId]
  );
  const renderPerson = useCallback(
    ({ item, index }: ListRenderItemInfo<PersonRow>) => (
      <PersonListRow
        // Positional, not identity-based: the probe needs a handle that exists
        // whatever the fixture seeded.
        testID={`${PEOPLE_LIST_ID}-row-${index}`}
        person={item}
        selected={selectedPartyId === item.party_id}
        colors={colors}
        onSelect={setSelectedId}
      />
    ),
    [colors, selectedPartyId]
  );
  const closeMerge = useCallback(() => setMergeOpen(false), []);
  const duplicateNames = (channel: ReplicaRow): string[] => {
    const duplicateIds = channels.rows
      .filter(
        (other) =>
          other.party_id !== channel.party_id &&
          other.kind === channel.kind &&
          other.normalized_value === channel.normalized_value
      )
      .map((other) => String(other.party_id));
    return duplicateIds.map((id) => partyNames.get(id) || id);
  };

  const write = async (action: string, input: Record<string, ReplicaValue>) => {
    if (!session) return undefined;
    try {
      const result = await session.write("people", { action, input });
      if (
        !surfaceWriteOutcome(result, {
          onParked: () =>
            navigation.navigate("Settings", { screen: "Approvals" }),
          queuedMessage: "This People change will sync automatically.",
        })
      )
        return undefined;
      return result;
    } catch (error) {
      surfaceWriteFailure(error, "People change failed");
      return undefined;
    }
  };
  const addPerson = async (): Promise<void> => {
    if (!name.trim()) return;
    const result = await write("add-person", {
      display_name: name.trim(),
      role: role.trim(),
      cadence_days: 30,
    });
    setName("");
    setRole("");
    const id = String(nativeWriteOutput(result)?.party_id ?? "");
    if (id) setSelectedId(id);
  };
  const resetChannel = (): void => {
    setEditingChannelId(undefined);
    setKind("phone");
    setLabel("");
    setChannelValue("");
    setPreferred(false);
  };
  const saveChannel = async (): Promise<void> => {
    if (!selected || !channelValue.trim()) return;
    const result = await write("save-contact-channel", {
      ...(editingChannelId ? { channel_id: editingChannelId } : {}),
      party_id: selected.party_id,
      kind,
      label: label.trim(),
      value: channelValue.trim(),
      preferred,
      provenance: { source: "manual", entered_via: "mobile-people" },
    });
    if (!result) return;
    const output = nativeWriteOutput(result);
    const duplicates = Array.isArray(output?.duplicate_party_ids)
      ? output.duplicate_party_ids.length
      : 0;
    const channelId = String(output?.channel_id ?? "");
    const revisionId = String(output?.revision_id ?? "");
    resetChannel();
    if (duplicates > 0)
      postStatus(
        `Possible duplicate — this channel is also used by ${duplicates} other person${duplicates === 1 ? "" : "s"}.`
      );
    else if (revisionId && channelId)
      showUndoStatus(
        "Contact saved. The previous value can be restored.",
        () =>
          void write("undo-contact-channel", {
            channel_id: channelId,
            revision_id: revisionId,
          })
      );
  };
  const deleteChannel = (channel: ReplicaRow): void => {
    Alert.alert("Delete contact channel?", String(channel.value ?? ""), [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          void write("delete-contact-channel", {
            channel_id: String(channel.channel_id),
          }).then((result) => {
            const revisionId = String(
              nativeWriteOutput(result)?.revision_id ?? ""
            );
            if (!revisionId) return;
            showUndoStatus(
              "Contact deleted. You can restore it now.",
              () =>
                void write("undo-contact-channel", {
                  channel_id: String(channel.channel_id),
                  revision_id: revisionId,
                })
            );
          }),
      },
    ]);
  };
  const merge = (target: PersonRow): void => {
    if (!selected) return;
    Alert.alert(
      `Merge ${String(selected.name)} into ${String(target.name)}?`,
      "This folds every reference into the survivor and deletes the duplicate. It cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Merge",
          style: "destructive",
          onPress: () =>
            void write("merge-people", {
              source_party_id: selected.party_id,
              target_party_id: String(target.party_id),
            }).then((result) => {
              if (!result) return;
              setSelectedId(String(target.party_id));
              closeMerge();
              postStatus(
                "People merged — references now point at the survivor."
              );
            }),
        },
      ]
    );
  };

  return (
    <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <HomeKey variant="leave" onPress={() => navigation.goBack()} />
        <View>
          <Text style={[styles.title, { color: colors.text }]}>People</Text>
          <Text style={[styles.meta, { color: colors.textFaint }]}>
            Normalized contacts and duplicate-safe merges
          </Text>
        </View>
      </View>
      <ReplicaStatusBar />
      <ReplicaStateCard
        noun="People"
        connection={queryState.connection}
        error={queryState.error}
        unavailableReason={queryState.unavailableReason}
        onRetry={() =>
          void Promise.all([
            profiles.refresh(),
            parties.refresh(),
            channels.refresh(),
          ])
        }
      />
      <View style={styles.addRow}>
        <TextInput
          accessibilityLabel="Person name"
          value={name}
          placeholder="Name"
          placeholderTextColor={colors.textFaint}
          onChangeText={setName}
          style={[
            styles.input,
            { borderColor: colors.line, color: colors.text },
          ]}
        />
        <TextInput
          accessibilityLabel="Person role"
          value={role}
          placeholder="Role"
          placeholderTextColor={colors.textFaint}
          onChangeText={setRole}
          style={[
            styles.input,
            { borderColor: colors.line, color: colors.text },
          ]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add person"
          hitSlop={6}
          onPress={() => void addPerson()}
          style={[styles.add, { backgroundColor: colors.accentFill }]}
        >
          <Icon name="user-plus" size={18} color={colors.textInv} />
        </Pressable>
      </View>
      <View style={styles.body}>
        <FlatList
          testID={PEOPLE_LIST_ID}
          accessibilityLabel="People directory"
          data={people}
          style={styles.directory}
          keyExtractor={keyOfPerson}
          renderItem={renderPerson}
          // Rows are a fixed `PERSON_ROW_HEIGHT`, so the list can place any
          // index arithmetically instead of measuring its way down — the
          // difference between an instant and a multi-second `scrollToIndex`
          // once the directory is thousands of people long.
          getItemLayout={personItemLayout}
          // Sized to the row, not copied from a cheat sheet: a ~60pt row fills
          // a phone screen in about 14, so a first batch of 16 covers the fold
          // and `windowSize` 5 keeps two screens of scrollback either side.
          initialNumToRender={16}
          maxToRenderPerBatch={12}
          windowSize={5}
          removeClippedSubviews
        />
        <ScrollView
          style={styles.detail}
          contentContainerStyle={styles.detailContent}
        >
          {selected ? (
            <>
              <Text style={[styles.detailTitle, { color: colors.text }]}>
                {String(selected.name)}
              </Text>
              <Pressable onPress={() => setMergeOpen(true)}>
                <Text style={{ color: colors.danger }}>Merge duplicate…</Text>
              </Pressable>
              {selectedChannels.map((channel) => {
                const duplicates = duplicateNames(channel);
                return (
                  <View
                    key={String(channel.channel_id)}
                    style={[
                      styles.channel,
                      {
                        backgroundColor: colors.bgElev,
                        borderColor: colors.line,
                      },
                    ]}
                  >
                    <Pressable
                      style={{ flex: 1 }}
                      onPress={() => {
                        setEditingChannelId(String(channel.channel_id));
                        setKind(String(channel.kind) as ChannelKind);
                        setLabel(String(channel.label ?? ""));
                        setChannelValue(String(channel.value ?? ""));
                        setPreferred(Boolean(channel.is_preferred));
                      }}
                    >
                      <Text style={[styles.personName, { color: colors.text }]}>
                        {channel.is_preferred ? "★ " : ""}
                        {String(channel.value)}
                      </Text>
                      <Text style={[styles.meta, { color: colors.textFaint }]}>
                        {String(channel.label ?? channel.kind)} ·{" "}
                        {channel.provenance_json
                          ? "provenance saved"
                          : "manual"}
                      </Text>
                      {duplicates.length > 0 ? (
                        <Text
                          style={[styles.warning, { color: colors.danger }]}
                        >
                          Possible duplicate: {duplicates.join(", ")}
                        </Text>
                      ) : null}
                    </Pressable>
                    <Pressable
                      accessibilityLabel="Delete contact channel"
                      onPress={() => deleteChannel(channel)}
                    >
                      <Icon name="trash-2" size={18} color={colors.danger} />
                    </Pressable>
                  </View>
                );
              })}
              <View style={[styles.form, { borderColor: colors.line }]}>
                <ScrollView horizontal contentContainerStyle={styles.kindRow}>
                  {(["phone", "email", "address", "handle"] as const).map(
                    (choice) => (
                      <Pressable key={choice} onPress={() => setKind(choice)}>
                        <Text
                          style={{
                            color:
                              kind === choice
                                ? colors.accent
                                : colors.textFaint,
                          }}
                        >
                          {choice}
                        </Text>
                      </Pressable>
                    )
                  )}
                </ScrollView>
                <TextInput
                  value={label}
                  placeholder="Label"
                  placeholderTextColor={colors.textFaint}
                  onChangeText={setLabel}
                  style={[
                    styles.input,
                    { borderColor: colors.line, color: colors.text },
                  ]}
                />
                <TextInput
                  value={channelValue}
                  placeholder={`New ${kind}`}
                  placeholderTextColor={colors.textFaint}
                  onChangeText={setChannelValue}
                  style={[
                    styles.input,
                    { borderColor: colors.line, color: colors.text },
                  ]}
                />
                <View style={styles.switchRow}>
                  <Text style={{ color: colors.textSoft }}>Preferred</Text>
                  <Switch value={preferred} onValueChange={setPreferred} />
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void saveChannel()}
                    style={[
                      styles.save,
                      { backgroundColor: colors.accentFill },
                    ]}
                  >
                    <Text style={{ color: colors.textInv }}>
                      {editingChannelId ? "Update" : "Add channel"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </>
          ) : (
            <Text style={{ color: colors.textFaint }}>
              Add your first person.
            </Text>
          )}
        </ScrollView>
      </View>
      <MergePicker
        visible={mergeOpen}
        people={people}
        keepingName={selected ? String(selected.name) : undefined}
        excludePartyId={selectedPartyId}
        colors={colors}
        onClose={closeMerge}
        onPick={merge}
      />
      {/* People is a root native-stack cover too; keep the DEV sampler inside
        the presented hierarchy so iOS Maestro can see its arm/report nodes. */}
      <FrameProbe />
    </TopSafeArea>
  );
}
