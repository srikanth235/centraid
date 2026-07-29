// governance: allow-repo-hygiene file-size-limit — native People intentionally
// keeps the offline directory, channel CRUD, duplicate review, and merge undo
// in one first-class cover so every visible control maps to a receipted action.
import type { ReplicaRow, ReplicaValue } from "@centraid/client/replica/native";
import { Feather } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import HomeKey from "../../kit/components/HomeKey";
import {
  combineReplicaQueryStates,
  useReplicaQuery,
} from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { family, radii, useTheme } from "../../kit/theme";
import type { NativeWriteResult } from "../../lib/replica/native-session";
import type { PeopleScreenProps } from "../../navigation";

type ChannelKind = "phone" | "email" | "address" | "handle";
type PersonRow = ReplicaRow & {
  party_id: string;
  name: string;
  role?: ReplicaValue;
};
const text = (row: ReplicaRow | undefined, key: string): string =>
  row?.[key] == null ? "" : String(row[key]);
const outputOf = (
  result: NativeWriteResult | undefined
): Record<string, ReplicaValue> | undefined =>
  result && "output" in result && result.output
    ? (result.output as Record<string, ReplicaValue>)
    : undefined;

export default function PeopleHome({
  navigation,
}: PeopleScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const profiles = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "people.profile" }), [])
  );
  const parties = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "core.party" }), [])
  );
  const channels = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "social.contact_channel" }), [])
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

  const people = useMemo<PersonRow[]>(
    () =>
      profiles.rows
        .filter((profile) => !profile.deleted_at)
        .map((profile) => {
          const party = parties.rows.find(
            (candidate) => candidate.party_id === profile.party_id
          );
          return {
            ...profile,
            party_id: String(profile.party_id),
            name: text(party, "display_name") || "Unnamed person",
          } as PersonRow;
        })
        .toSorted((a, b) => String(a.name).localeCompare(String(b.name))),
    [parties.rows, profiles.rows]
  );
  const selected =
    people.find((person) => person.party_id === selectedId) ?? people[0];
  const selectedChannels = channels.rows
    .filter((channel) => channel.party_id === selected?.party_id)
    .toSorted(
      (a, b) =>
        Number(b.is_preferred ?? 0) - Number(a.is_preferred ?? 0) ||
        String(a.kind).localeCompare(String(b.kind))
    );
  const duplicateNames = (channel: ReplicaRow): string[] => {
    const duplicateIds = channels.rows
      .filter(
        (other) =>
          other.party_id !== channel.party_id &&
          other.kind === channel.kind &&
          other.normalized_value === channel.normalized_value
      )
      .map((other) => String(other.party_id));
    return duplicateIds.map(
      (id) =>
        text(
          parties.rows.find((party) => party.party_id === id),
          "display_name"
        ) || id
    );
  };

  const write = async (action: string, input: Record<string, ReplicaValue>) => {
    if (!session) return undefined;
    const result = await session.write("people", { action, input });
    if (result.status === "queued")
      Alert.alert(
        "Saved offline",
        "This People change will sync automatically."
      );
    if (result.status === "parked")
      navigation.navigate("Settings", { screen: "Approvals" });
    return result;
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
    const id = String(outputOf(result)?.party_id ?? "");
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
    const output = outputOf(result);
    const duplicates = Array.isArray(output?.duplicate_party_ids)
      ? output.duplicate_party_ids.length
      : 0;
    const channelId = String(output?.channel_id ?? "");
    const revisionId = String(output?.revision_id ?? "");
    resetChannel();
    if (duplicates > 0)
      Alert.alert(
        "Possible duplicate",
        `This channel is also used by ${duplicates} other person${duplicates === 1 ? "" : "s"}. Review before merging.`
      );
    else if (revisionId && channelId)
      Alert.alert("Contact saved", "The previous value can be restored.", [
        { text: "Done" },
        {
          text: "Undo",
          onPress: () =>
            void write("undo-contact-channel", {
              channel_id: channelId,
              revision_id: revisionId,
            }),
        },
      ]);
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
            const revisionId = String(outputOf(result)?.revision_id ?? "");
            if (!revisionId) return;
            Alert.alert("Contact deleted", "You can restore it now.", [
              { text: "Done" },
              {
                text: "Undo",
                onPress: () =>
                  void write("undo-contact-channel", {
                    channel_id: String(channel.channel_id),
                    revision_id: revisionId,
                  }),
              },
            ]);
          }),
      },
    ]);
  };
  const merge = (target: PersonRow): void => {
    if (!selected) return;
    Alert.alert(
      `Merge ${String(selected.name)} into ${String(target.name)}?`,
      "The source identity and contact provenance remain recoverable.",
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
              const revisionId = String(outputOf(result)?.revision_id ?? "");
              const sourceId = String(selected.party_id);
              setSelectedId(String(target.party_id));
              setMergeOpen(false);
              Alert.alert("People merged", "The merge can be undone once.", [
                { text: "Done" },
                {
                  text: "Undo",
                  onPress: () =>
                    void write("undo-merge", {
                      source_party_id: sourceId,
                      revision_id: revisionId,
                    }),
                },
              ]);
            }),
        },
      ]
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <HomeKey variant="leave" onPress={() => navigation.goBack()} />
        <View>
          <Text style={[styles.title, { color: colors.ink }]}>People</Text>
          <Text style={[styles.meta, { color: colors.ink3 }]}>
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
          placeholderTextColor={colors.ink3}
          onChangeText={setName}
          style={[
            styles.input,
            { borderColor: colors.line, color: colors.ink },
          ]}
        />
        <TextInput
          accessibilityLabel="Person role"
          value={role}
          placeholder="Role"
          placeholderTextColor={colors.ink3}
          onChangeText={setRole}
          style={[
            styles.input,
            { borderColor: colors.line, color: colors.ink },
          ]}
        />
        <Pressable
          onPress={() => void addPerson()}
          style={[styles.add, { backgroundColor: colors.accent }]}
        >
          <Feather name="user-plus" size={18} color={colors.bg} />
        </Pressable>
      </View>
      <View style={styles.body}>
        <FlatList
          data={people}
          style={styles.directory}
          keyExtractor={(person) => String(person.party_id)}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{
                selected: selected?.party_id === item.party_id,
              }}
              onPress={() => setSelectedId(String(item.party_id))}
              style={[
                styles.person,
                {
                  backgroundColor:
                    selected?.party_id === item.party_id
                      ? colors.bgSunken
                      : colors.bg,
                  borderColor: colors.line,
                },
              ]}
            >
              <Text style={[styles.personName, { color: colors.ink }]}>
                {String(item.name)}
              </Text>
              <Text style={[styles.meta, { color: colors.ink3 }]}>
                {String(item.role ?? "No role")}
              </Text>
            </Pressable>
          )}
        />
        <ScrollView
          style={styles.detail}
          contentContainerStyle={styles.detailContent}
        >
          {selected ? (
            <>
              <Text style={[styles.detailTitle, { color: colors.ink }]}>
                {String(selected.name)}
              </Text>
              <Pressable onPress={() => setMergeOpen((current) => !current)}>
                <Text style={{ color: colors.danger }}>
                  {mergeOpen ? "Cancel merge" : "Merge duplicate…"}
                </Text>
              </Pressable>
              {mergeOpen
                ? people
                    .filter((person) => person.party_id !== selected.party_id)
                    .map((person) => (
                      <Pressable
                        key={String(person.party_id)}
                        onPress={() => merge(person)}
                        style={[styles.merge, { borderColor: colors.line }]}
                      >
                        <Text style={{ color: colors.ink }}>
                          Merge into {String(person.name)}
                        </Text>
                      </Pressable>
                    ))
                : null}
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
                      <Text style={[styles.personName, { color: colors.ink }]}>
                        {channel.is_preferred ? "★ " : ""}
                        {String(channel.value)}
                      </Text>
                      <Text style={[styles.meta, { color: colors.ink3 }]}>
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
                      <Feather name="trash-2" size={18} color={colors.danger} />
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
                              kind === choice ? colors.accent : colors.ink3,
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
                  placeholderTextColor={colors.ink3}
                  onChangeText={setLabel}
                  style={[
                    styles.input,
                    { borderColor: colors.line, color: colors.ink },
                  ]}
                />
                <TextInput
                  value={channelValue}
                  placeholder={`New ${kind}`}
                  placeholderTextColor={colors.ink3}
                  onChangeText={setChannelValue}
                  style={[
                    styles.input,
                    { borderColor: colors.line, color: colors.ink },
                  ]}
                />
                <View style={styles.switchRow}>
                  <Text style={{ color: colors.ink2 }}>Preferred</Text>
                  <Switch value={preferred} onValueChange={setPreferred} />
                  <Pressable
                    onPress={() => void saveChannel()}
                    style={[styles.save, { backgroundColor: colors.accent }]}
                  >
                    <Text style={{ color: colors.bg }}>
                      {editingChannelId ? "Update" : "Add channel"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </>
          ) : (
            <Text style={{ color: colors.ink3 }}>Add your first person.</Text>
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  add: {
    alignItems: "center",
    borderRadius: 12,
    justifyContent: "center",
    width: 44,
  },
  addRow: { flexDirection: "row", gap: 8, padding: 12 },
  body: { flex: 1, flexDirection: "row" },
  channel: {
    alignItems: "center",
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    padding: 12,
  },
  detail: { flex: 1.45 },
  detailContent: { gap: 10, padding: 12, paddingBottom: 80 },
  detailTitle: { fontFamily: family.displayBold, fontSize: 23 },
  directory: { flex: 1 },
  form: { borderRadius: radii.lg, borderWidth: 1, gap: 9, padding: 10 },
  header: { alignItems: "center", flexDirection: "row", gap: 12, padding: 16 },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    minWidth: 72,
    padding: 10,
  },
  kindRow: { gap: 16, paddingVertical: 4 },
  merge: { borderRadius: 8, borderWidth: 1, padding: 9 },
  meta: { fontFamily: family.sansRegular, fontSize: 12 },
  person: { borderBottomWidth: 1, padding: 13 },
  personName: { fontFamily: family.sansMedium, fontSize: 14 },
  safe: { flex: 1 },
  save: {
    borderRadius: 10,
    marginLeft: "auto",
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  switchRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  title: { fontFamily: family.displayBold, fontSize: 28 },
  warning: { fontFamily: family.sansMedium, fontSize: 11, marginTop: 3 },
});
