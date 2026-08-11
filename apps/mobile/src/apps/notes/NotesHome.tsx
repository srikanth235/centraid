import { FlashList } from "@shopify/flash-list";
import React, { useEffect, useMemo, useState } from "react";
/*! governance: allow-repo-hygiene file-size-limit — the native Notes cover keeps its CommonMark draft, lifecycle actions, wikilink powerbox, and backlinks in one focus-contained editor so write outcomes cannot be silently orphaned. */
import {
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";

import { parseWikiLinks } from "@centraid/blueprints/apps/notes/commonmark";
import { notesPendingProjection } from "@centraid/blueprints/apps/notes/pending-projection";
import type { ReplicaValue } from "@centraid/client/replica/native";

import HomeKey from "../../kit/components/HomeKey";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { pendingProjector } from "../../kit/replica/pending-rows";
import type { PendingRowMark } from "../../kit/replica/pending-rows";
import PendingChip from "../../kit/replica/PendingChip";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { usePendingRows } from "../../kit/replica/usePendingRows";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { useTheme } from "../../kit/theme";
import type { NotesScreenProps } from "../../navigation";
import { searchBlueprints } from "../../screens/home/blueprint-search";
import type { BlueprintSearchHit } from "../../screens/home/blueprint-search";
import type { NativeNote } from "./notes-model";
import { styles } from "./NotesHome.styles";
import { useNotes } from "./useNotes";

interface WikiToken {
  raw: string;
  label: string;
  start: number;
  end: number;
}

function anchorExact(reference: NativeNote["references"][number]): string {
  const anchor = reference.anchor;
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return "";
  const selector = anchor.selector_json;
  if (typeof selector !== "string") return "";
  try {
    const parsed = JSON.parse(selector) as { exact?: unknown };
    return typeof parsed.exact === "string" ? parsed.exact : "";
  } catch {
    return "";
  }
}

function unresolvedLinks(note: NativeNote, body: string): WikiToken[] {
  const resolved = new Set(note.references.map(anchorExact).filter(Boolean));
  return parseWikiLinks(body).filter((token) => !resolved.has(token.raw));
}

function NoteRow({
  note,
  pending,
  onOpen,
}: {
  note: NativeNote;
  pending?: PendingRowMark;
  onOpen: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const preview = note.body
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/\[\[(?<label>[^\]]+)\]\]/gu, "$<label>")
    .replace(/\s+/gu, " ")
    .trim();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open note ${note.title}`}
      onPress={onOpen}
      style={[styles.note, { borderBottomColor: colors.line }]}
    >
      <Text
        numberOfLines={1}
        style={[styles.noteTitle, { color: colors.text }]}
      >
        {note.pinned ? "◆ " : ""}
        {note.title}
      </Text>
      {preview ? (
        <Text
          numberOfLines={2}
          style={[styles.notePreview, { color: colors.textSoft }]}
        >
          {preview}
        </Text>
      ) : null}
      <Text style={[styles.noteMeta, { color: colors.textFaint }]}>
        {new Date(note.updatedAt).toLocaleString()}
        {note.references.length ? ` · ${note.references.length} links` : ""}
        {note.backlinks.length ? ` · ${note.backlinks.length} backlinks` : ""}
      </Text>
      {pending ? <PendingChip mark={pending} /> : null}
    </Pressable>
  );
}

export default function NotesHome({
  navigation,
}: NotesScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const { session, refresh } = useReplica();
  const { marks: pendingRows, refresh: refreshPending } =
    usePendingRows("notes");
  const state = useNotes();
  const [showTrash, setShowTrash] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<{
    query: string;
    ids: Set<string>;
  }>();
  const [selected, setSelected] = useState<NativeNote>();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [linkToken, setLinkToken] = useState<WikiToken>();
  const [targets, setTargets] = useState<BlueprintSearchHit[]>([]);
  const [findingTargets, setFindingTargets] = useState(false);

  const editorOpen = creating || selected !== undefined;
  const trimmedQuery = query.trim();
  const matchIds =
    searchResult?.query === trimmedQuery ? searchResult.ids : undefined;
  useEffect(() => {
    if (!session || !trimmedQuery) return;
    let active = true;
    const timeout = setTimeout(
      () =>
        void session
          .search("notes", {
            entity: "knowledge.note",
            query: trimmedQuery,
            limit: 200,
          })
          .then((result) => {
            if (!active) return;
            setSearchResult({
              query: trimmedQuery,
              ids: new Set(
                result.rows.flatMap((row) => {
                  const value = row.values;
                  if (!value || Array.isArray(value)) return [];
                  const id = value.note_id;
                  const scope = value.__centraidScopeId;
                  if (typeof id !== "string") return [];
                  return [typeof scope === "string" ? `${scope}:${id}` : id];
                })
              ),
            });
          })
          .catch(() => {
            if (active)
              setSearchResult({ query: trimmedQuery, ids: new Set() });
          }),
      160
    );
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [session, trimmedQuery]);

  const visible = useMemo(
    () =>
      state.notes.filter(
        (note) =>
          note.trashed === showTrash && (!matchIds || matchIds.has(note.id))
      ),
    [matchIds, showTrash, state.notes]
  );

  const closeEditor = (): void => {
    setCreating(false);
    setSelected(undefined);
    setLinkToken(undefined);
    setTargets([]);
    setTitle("");
    setBody("");
  };
  const openNote = (note: NativeNote): void => {
    setSelected(note);
    setCreating(false);
    setTitle(note.title);
    setBody(note.body);
  };
  const createNote = (): void => {
    setCreating(true);
    setSelected(undefined);
    setTitle("");
    setBody("");
  };

  const write = async (
    action: string,
    input: Record<string, ReplicaValue>,
    note = selected
  ): Promise<boolean> => {
    if (!session) return false;
    if (note && !note.canWrite) {
      postStatus(
        "Read-only note — choose the writable copy in its source vault."
      );
      return false;
    }
    try {
      const request = {
        action,
        input: input as ReplicaValue,
        optimistic: pendingProjector(notesPendingProjection, action, input),
      };
      const result =
        note?.sourceVaultId && session.writeTo
          ? await session.writeTo(note.sourceVaultId, "notes", request)
          : await session.write("notes", request);
      refreshPending();
      return surfaceWriteOutcome(result, {
        onParked: () => {
          closeEditor();
          navigation.navigate("Settings", { screen: "Approvals" });
        },
        queuedMessage: "This Notes change will sync automatically.",
        failureTitle: "Not applied",
      });
    } catch (error) {
      surfaceWriteFailure(error, "Action failed");
      return false;
    }
  };

  const save = async (): Promise<void> => {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      postStatus("Add a title before saving this note.");
      return;
    }
    const cleanBody = body || cleanTitle;
    const changed = selected
      ? await write("edit-note", {
          note_id: selected.rawId,
          title: cleanTitle,
          body_text: cleanBody,
          format: "markdown",
        })
      : await write(
          "create-note",
          {
            title: cleanTitle,
            body_text: cleanBody,
            format: "markdown",
          },
          undefined
        );
    if (changed) closeEditor();
  };

  const lifecycle = async (
    action: "delete-note" | "restore-note"
  ): Promise<void> => {
    if (!selected) return;
    if (await write(action, { note_id: selected.rawId })) closeEditor();
  };

  const confirmTrash = (): void => {
    if (!selected) return;
    Alert.alert(
      `Move “${selected.title}” to trash?`,
      "The note, its history, attachments, links, and notebook placement stay recoverable for 30 days.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Move to trash",
          style: "destructive",
          onPress: () => void lifecycle("delete-note"),
        },
      ]
    );
  };

  const togglePin = async (): Promise<void> => {
    if (!selected) return;
    if (
      await write("edit-note", {
        note_id: selected.rawId,
        pinned: selected.pinned ? 0 : 1,
      })
    ) {
      setSelected({ ...selected, pinned: !selected.pinned });
    }
  };

  const findTargets = async (token: WikiToken): Promise<void> => {
    if (!session) return;
    setLinkToken(token);
    setTargets([]);
    setFindingTargets(true);
    try {
      setTargets(
        (await searchBlueprints(session, token.label)).filter(
          (target) =>
            !(
              target.entity === "knowledge.note" &&
              target.id === selected?.rawId
            )
        )
      );
    } finally {
      setFindingTargets(false);
    }
  };

  const linkTarget = async (target: BlueprintSearchHit): Promise<void> => {
    if (!selected || !linkToken) return;
    const changed = await write("link", {
      note_id: selected.rawId,
      target_type: target.entity,
      target_id: target.id,
      exact: linkToken.raw,
      prefix: body.slice(Math.max(0, linkToken.start - 32), linkToken.start),
      suffix: body.slice(linkToken.end, linkToken.end + 32),
      start: linkToken.start,
    });
    if (changed) {
      setLinkToken(undefined);
      setTargets([]);
      await refresh?.();
    }
  };

  const pull = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refresh?.();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <TopSafeArea style={[styles.fill, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <HomeKey variant="leave" onPress={() => navigation.goBack()} />
        <View style={styles.headerCopy}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            Notes
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSoft }]}>
            Portable CommonMark · links stay in your vault
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create note"
          onPress={createNote}
          style={styles.iconButton}
        >
          <Icon name="plus" size={24} color={colors.accent} />
        </Pressable>
      </View>
      <ReplicaStatusBar />
      <View style={styles.controls}>
        <View
          style={[
            styles.search,
            { backgroundColor: colors.bgElev, borderColor: colors.line },
          ]}
        >
          <Icon name="search" size={17} color={colors.textFaint} />
          <TextInput
            accessibilityLabel="Search notes"
            value={query}
            onChangeText={setQuery}
            placeholder="Search notes"
            placeholderTextColor={colors.textFaint}
            style={[styles.searchInput, { color: colors.text }]}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: showTrash }}
          accessibilityLabel={showTrash ? "Show active notes" : "Show trash"}
          onPress={() => setShowTrash((value) => !value)}
          style={[
            styles.chip,
            {
              backgroundColor: showTrash ? colors.accentFill : colors.bgElev,
              borderColor: colors.line,
            },
          ]}
        >
          <Text
            style={[
              styles.chipText,
              { color: showTrash ? colors.textInv : colors.textSoft },
            ]}
          >
            {showTrash ? "Notes" : "Trash"}
          </Text>
        </Pressable>
      </View>

      <ReplicaStateCard
        connection={state.connection}
        error={state.error}
        unavailableReason={state.unavailableReason}
        noun="Notes"
        onRetry={() => void refresh?.()}
      />
      {state.connection !== "unavailable" && !state.error ? (
        <FlashList
          data={visible}
          keyExtractor={(note) => note.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void pull()}
            />
          }
          renderItem={({ item }) => {
            const pending = pendingRows.get(item.rawId);
            return (
              <NoteRow
                note={item}
                {...(pending ? { pending } : {})}
                onOpen={() => openNote(item)}
              />
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Icon
                name={showTrash ? "trash-2" : "book-open"}
                size={32}
                color={colors.textFaint}
              />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>
                {query.trim()
                  ? "No matching notes"
                  : showTrash
                    ? "Trash is empty"
                    : "Start with one note"}
              </Text>
              <Text style={[styles.emptyBody, { color: colors.textSoft }]}>
                {showTrash
                  ? "Deleted notes remain recoverable here for 30 days."
                  : "Your source stays portable CommonMark; [[wikilinks]] can point to anything in Centraid."}
              </Text>
            </View>
          }
        />
      ) : null}

      <Modal
        visible={editorOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeEditor}
      >
        <TopSafeArea
          accessibilityViewIsModal
          style={[styles.sheet, { backgroundColor: colors.bg }]}
        >
          <View style={styles.modalHeader}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close note editor"
              onPress={closeEditor}
              style={styles.iconButton}
            >
              <Icon name="x" size={23} color={colors.text} />
            </Pressable>
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {creating
                ? "New note"
                : selected?.trashed
                  ? "Trashed note"
                  : "Edit note"}
            </Text>
            {selected && !selected.trashed ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={selected.pinned ? "Unpin note" : "Pin note"}
                accessibilityState={{ selected: selected.pinned }}
                onPress={() => void togglePin()}
                style={styles.iconButton}
              >
                <Icon
                  name="bookmark"
                  size={21}
                  color={selected.pinned ? colors.accent : colors.textFaint}
                />
              </Pressable>
            ) : null}
          </View>
          <ScrollView
            style={styles.editor}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 28 }}
          >
            <TextInput
              accessibilityLabel="Note title"
              editable={!selected?.trashed}
              value={title}
              onChangeText={setTitle}
              placeholder="Title"
              placeholderTextColor={colors.textFaint}
              style={[
                styles.title,
                { borderBottomColor: colors.line, color: colors.text },
              ]}
            />
            <TextInput
              accessibilityLabel="CommonMark note body"
              editable={!selected?.trashed}
              multiline
              value={body}
              onChangeText={setBody}
              placeholder={"Write in CommonMark…\nUse [[anything]] to link it."}
              placeholderTextColor={colors.textFaint}
              style={[styles.body, { color: colors.text }]}
            />
            {selected && !selected.trashed ? (
              <View style={styles.linkWrap}>
                {unresolvedLinks(selected, body).map((token) => (
                  <Pressable
                    key={`${token.start}:${token.raw}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Choose a target for broken link ${token.label}`}
                    onPress={() => void findTargets(token)}
                    style={[styles.linkAction, { borderColor: colors.danger }]}
                  >
                    <Text style={[styles.linkTitle, { color: colors.danger }]}>
                      Broken link: {token.label}
                    </Text>
                    <Text style={[styles.linkMeta, { color: colors.textSoft }]}>
                      Choose a note, person, event, task, expense, photo, or
                      document.
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {selected?.backlinks.length ? (
              <View style={styles.backlinks}>
                <Text style={[styles.linkTitle, { color: colors.text }]}>
                  Backlinks
                </Text>
                {selected.backlinks.map((reference) => (
                  <View
                    key={String(reference.link_id)}
                    style={[styles.backlink, { borderColor: colors.line }]}
                  >
                    <Text
                      style={[styles.backlinkLabel, { color: colors.text }]}
                    >
                      {String(reference.from_type)} ·{" "}
                      {String(reference.from_id)}
                    </Text>
                    <Text
                      style={[styles.backlinkMeta, { color: colors.textFaint }]}
                    >
                      references this note
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </ScrollView>
          <View style={styles.editorActions}>
            {selected?.trashed ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void lifecycle("restore-note")}
                style={[styles.button, { backgroundColor: colors.accentFill }]}
              >
                <Icon name="rotate-ccw" size={17} color={colors.textInv} />
                <Text style={[styles.buttonText, { color: colors.textInv }]}>
                  Restore note
                </Text>
              </Pressable>
            ) : (
              <>
                {selected ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${selected.title} to trash`}
                    onPress={confirmTrash}
                    style={[
                      styles.button,
                      { borderColor: colors.danger, borderWidth: 1 },
                    ]}
                  >
                    <Icon name="trash-2" size={17} color={colors.danger} />
                    <Text style={[styles.buttonText, { color: colors.danger }]}>
                      Trash
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void save()}
                  style={[
                    styles.button,
                    { backgroundColor: colors.accentFill, flex: 1 },
                  ]}
                >
                  <Text style={[styles.buttonText, { color: colors.textInv }]}>
                    Save note
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        </TopSafeArea>
      </Modal>

      <Modal
        visible={linkToken !== undefined}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setLinkToken(undefined)}
      >
        <TopSafeArea
          accessibilityViewIsModal
          style={[styles.sheet, { backgroundColor: colors.bg }]}
        >
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              Link “{linkToken?.label}”
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close link target picker"
              onPress={() => setLinkToken(undefined)}
              style={styles.iconButton}
            >
              <Icon name="x" size={23} color={colors.text} />
            </Pressable>
          </View>
          <ScrollView style={styles.picker}>
            <Text style={[styles.pickerCopy, { color: colors.textSoft }]}>
              The text stays CommonMark. Your choice creates a typed, temporal
              vault link and a text anchor separately.
            </Text>
            {findingTargets ? (
              <Text style={[styles.pickerCopy, { color: colors.textSoft }]}>
                Searching every app…
              </Text>
            ) : targets.length === 0 ? (
              <Text style={[styles.pickerCopy, { color: colors.textSoft }]}>
                No matching entity. The broken link remains readable text.
              </Text>
            ) : (
              targets.map((target) => (
                <Pressable
                  key={`${target.entity}:${target.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Link to ${target.label} in ${target.appLabel}`}
                  onPress={() => void linkTarget(target)}
                  style={[styles.note, { borderBottomColor: colors.line }]}
                >
                  <Text style={[styles.noteTitle, { color: colors.text }]}>
                    {target.label}
                  </Text>
                  <Text style={[styles.noteMeta, { color: colors.textFaint }]}>
                    {target.appLabel}
                    {target.detail ? ` · ${target.detail}` : ""}
                  </Text>
                </Pressable>
              ))
            )}
          </ScrollView>
        </TopSafeArea>
      </Modal>
    </TopSafeArea>
  );
}
