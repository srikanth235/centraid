/*! governance: allow-repo-hygiene file-size-limit — the native Notes cover keeps its places, its list, its editor and the two origin acts in one focus-contained screen so a write outcome cannot be silently orphaned. */
// Notes, the native cover (Notes spec §1, §2, rebuilt for #834).
//
// WHAT THIS SEAT IS. `handler-reachability.test.ts` files Notes under
// `WEBVIEW_APPS`, which means its handler dispatch is answered by the WEB
// source: the phone is not expected to re-dispatch every note command. The
// name predates #799: there is no WebView host anywhere in this app
// (`screens/home/catalog.ts` says so), so what stands here is a native cover
// over the SAME replica the
// web app reads, drawn to the same spec and sharing its pure logic:
// `promote` is imported from the blueprint, not re-derived, so first-line
// promotion cannot mean two things on two seats.
//
// The two ORIGIN ACTS are the phone's alone. Capture hands off to the frame's
// own Scan cover, which already owns the camera permission and the on-device
// review — a second camera flow would be a second thing to keep honest. Voice
// has no recorder on this seat and says so rather than drawing a button that
// cannot record.
import { FlashList } from "@shopify/flash-list";
import React, { useMemo, useState } from "react";
import { Alert, Modal, Pressable, RefreshControl, View } from "react-native";

import {
  pendingChangeLabel,
  readPendingOverlay,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import { promote } from "@centraid/blueprints/apps/notes/format";
import {
  CAPTURE_CUSTODY,
  CAPTURE_SCANNER,
  CAPTURE_WHAT,
  DELETE_NOTE_BODY,
  DELETE_NOTE_TITLE,
  DELETE_NOTE_VERB,
  EMPTY_DAY_ONE,
  JOURNAL_ROW,
  TRASH_STATUS,
  VOICE_AUDIO_READABLE,
  VOICE_NO_TRANSCRIPT_YET,
} from "@centraid/blueprints/apps/notes/view-copy";
import type { ReplicaValue } from "@centraid/client/replica/native";

import HomeKey from "../../kit/components/HomeKey";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { useTheme } from "../../kit/theme";
import type { NotesScreenProps } from "../../navigation";
import type { NativeNote } from "./notes-model";
import { styles } from "./NotesHome.styles";
import { useNotes } from "./useNotes";

/** The places this cover carries. Only a PLACE is a destination; Capture,
 *  Voice and Trash are acts, and they sit behind More. */
type Place = "library" | "journal" | "search" | "more";

const PLACES: ReadonlyArray<{ id: Place; label: string }> = [
  { id: "library", label: "Library" },
  { id: "journal", label: "Journal" },
  { id: "search", label: "Search" },
  { id: "more", label: "More" },
];

/** One row of the reading room. The heading is `promote`'s — a note with no
 *  title of its own shows its first line, and the preview picks up below. */
function NoteRow({
  note,
  onOpen,
}: {
  note: NativeNote;
  onOpen: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const shown = promote({ title: note.title, body: note.body });
  const overlay = readPendingOverlay(note.raw);
  const pending = overlay ? pendingChangeLabel(overlay) : "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${shown.heading || "the untitled note"}`}
      onPress={onOpen}
      style={[styles.note, { borderBottomColor: colors.line }]}
    >
      <Text
        numberOfLines={1}
        style={[styles.noteTitle, { color: colors.text }]}
      >
        {note.pinned ? "★ " : ""}
        {shown.heading}
      </Text>
      {shown.preview ? (
        <Text
          numberOfLines={2}
          style={[styles.notePreview, { color: colors.textSoft }]}
        >
          {shown.preview.replaceAll("\n", " ")}
        </Text>
      ) : null}
      <Text style={[styles.noteMeta, { color: colors.textFaint }]}>
        {new Date(note.updatedAt).toLocaleDateString()}
        {note.references.length ? ` · ${note.references.length} links` : ""}
      </Text>
      {/* A queued write says where it is, on the row it changed. The kit's
          own per-row chip left with the interfaces in #831, so the shared
          overlay reader is read directly here — one derivation, two seats. */}
      {pending ? (
        <Text style={[styles.noteMeta, { color: colors.textFaint }]}>
          {pending}
        </Text>
      ) : null}
    </Pressable>
  );
}

export default function NotesHome({
  navigation,
}: NotesScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const { session, refresh } = useReplica();
  const state = useNotes();
  const [place, setPlace] = useState<Place>("library");
  const [showTrash, setShowTrash] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<NativeNote>();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const editorOpen = creating || selected !== undefined;
  const term = query.trim().toLowerCase();

  // JOURNAL IS A PLACE, NEVER AN INTERLEAVE: the marker set leaves the
  // library, and the Journal place is the only thing that shows it.
  const visible = useMemo(() => {
    const journal = state.journalNoteIds;
    return state.notes.filter((note) => {
      const isJournal = journal.has(note.rawId);
      if (place === "journal") return isJournal && !note.trashed;
      if (isJournal) return false;
      if (showTrash) return note.trashed;
      if (note.trashed) return false;
      if (place === "search" && term) {
        const shown = promote({ title: note.title, body: note.body });
        return `${shown.heading} ${shown.preview}`.toLowerCase().includes(term);
      }
      return true;
    });
  }, [place, showTrash, state.journalNoteIds, state.notes, term]);

  const closeEditor = (): void => {
    setCreating(false);
    setSelected(undefined);
    setTitle("");
    setBody("");
  };

  const openNote = (note: NativeNote): void => {
    setSelected(note);
    setCreating(false);
    setTitle(note.title);
    setBody(note.body);
  };

  const write = async (
    action: string,
    input: Record<string, ReplicaValue>,
    note = selected
  ): Promise<boolean> => {
    if (!session) return false;
    if (note && !note.canWrite) {
      postStatus("Read-only note — open the writable copy in its own vault.");
      return false;
    }
    try {
      const request = { action, input: input as ReplicaValue };
      const result =
        note?.sourceVaultId && session.writeTo
          ? await session.writeTo(note.sourceVaultId, "notes", request)
          : await session.write("notes", request);
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

  /**
   * Save. The vault will not take a nameless note, so an untitled one is
   * named by its own first line — which is exactly what `promote` reads back
   * out, so the member never sees the derivation.
   */
  const save = async (): Promise<void> => {
    const typed = title.trim();
    const text = body.trim();
    if (!typed && !text) {
      postStatus("Write a line first.");
      return;
    }
    const name = typed || text.split("\n")[0]!.slice(0, 80);
    const changed = selected
      ? await write("edit-note", {
          note_id: selected.rawId,
          title: name,
          body_text: text || name,
          format: "markdown",
        })
      : await write(
          "create-note",
          { title: name, body_text: text || name, format: "markdown" },
          undefined
        );
    if (changed) closeEditor();
  };

  const confirmTrash = (): void => {
    if (!selected) return;
    // The one place the 30-day reassurance is allowed, in the words the spec
    // gives it — shared with the web seat so the two cannot drift.
    Alert.alert(DELETE_NOTE_TITLE, DELETE_NOTE_BODY, [
      { text: "Keep it", style: "cancel" },
      {
        text: DELETE_NOTE_VERB,
        style: "destructive",
        onPress: () => {
          void write("delete-note", { note_id: selected.rawId }).then(
            (done) => {
              if (done) closeEditor();
            }
          );
        },
      },
    ]);
  };

  const restore = async (): Promise<void> => {
    if (!selected) return;
    if (await write("restore-note", { note_id: selected.rawId })) closeEditor();
  };

  const togglePin = async (): Promise<void> => {
    if (!selected) return;
    if (
      await write("edit-note", {
        note_id: selected.rawId,
        pinned: selected.pinned ? 0 : 1,
      })
    )
      setSelected({ ...selected, pinned: !selected.pinned });
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
            {place === "journal" ? JOURNAL_ROW : TRASH_STATUS}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New note"
          onPress={() => {
            setCreating(true);
            setSelected(undefined);
            setTitle("");
            setBody("");
          }}
          style={styles.iconButton}
        >
          <Icon name="plus" size={24} color={colors.accent} />
        </Pressable>
      </View>
      <ReplicaStatusBar />

      {/* The band's own destinations, drawn as this cover's place row. */}
      <View style={styles.controls}>
        {PLACES.map((entry) => (
          <Pressable
            key={entry.id}
            accessibilityRole="button"
            accessibilityState={{ selected: place === entry.id }}
            accessibilityLabel={entry.label}
            onPress={() => {
              setPlace(entry.id);
              if (entry.id !== "more") setShowTrash(false);
            }}
            style={[
              styles.chip,
              {
                backgroundColor:
                  place === entry.id ? colors.accentFill : colors.bgElev,
                borderColor: colors.line,
              },
            ]}
          >
            <Text
              style={[
                styles.chipText,
                {
                  color: place === entry.id ? colors.textInv : colors.textSoft,
                },
              ]}
            >
              {entry.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {place === "search" ? (
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
              placeholder="Search titles and bodies"
              placeholderTextColor={colors.textFaint}
              style={[styles.searchInput, { color: colors.text }]}
            />
          </View>
        </View>
      ) : null}

      {place === "more" ? (
        <View style={styles.empty}>
          {/* THE TWO ORIGIN ACTS. Capture hands off to the frame's own camera
              cover; voice has no recorder on this seat and says so. */}
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {CAPTURE_SCANNER}
          </Text>
          <Text style={[styles.emptyBody, { color: colors.textSoft }]}>
            {CAPTURE_WHAT}
          </Text>
          <Text style={[styles.emptyBody, { color: colors.textFaint }]}>
            {CAPTURE_CUSTODY}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open the camera"
            onPress={() => navigation.navigate("Scan")}
            style={[styles.button, { backgroundColor: colors.accentFill }]}
          >
            <Text style={[styles.buttonText, { color: colors.textInv }]}>
              Open the camera
            </Text>
          </Pressable>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {VOICE_NO_TRANSCRIPT_YET}
          </Text>
          <Text style={[styles.emptyBody, { color: colors.textSoft }]}>
            {VOICE_AUDIO_READABLE}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: showTrash }}
            accessibilityLabel={showTrash ? "Show the library" : "Show trash"}
            onPress={() => {
              setShowTrash((value) => !value);
              setPlace("library");
            }}
            style={[
              styles.chip,
              { backgroundColor: colors.bgElev, borderColor: colors.line },
            ]}
          >
            <Text style={[styles.chipText, { color: colors.textSoft }]}>
              Trash
            </Text>
          </Pressable>
        </View>
      ) : (
        <>
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
              renderItem={({ item }) => (
                <NoteRow note={item} onOpen={() => openNote(item)} />
              )}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text style={[styles.emptyTitle, { color: colors.text }]}>
                    {showTrash ? "Trash is empty" : EMPTY_DAY_ONE}
                  </Text>
                  <Text style={[styles.emptyBody, { color: colors.textSoft }]}>
                    {showTrash ? TRASH_STATUS : JOURNAL_ROW}
                  </Text>
                </View>
              }
            />
          ) : null}
        </>
      )}

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
              accessibilityLabel="Close the note"
              onPress={closeEditor}
              style={styles.iconButton}
            >
              <Icon name="x" size={23} color={colors.text} />
            </Pressable>
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {creating ? "New note" : selected?.trashed ? "In trash" : "Note"}
            </Text>
            {selected && !selected.trashed ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={selected.pinned ? "Unpin" : "Pin"}
                accessibilityState={{ selected: selected.pinned }}
                onPress={() => void togglePin()}
                style={styles.iconButton}
              >
                <Icon
                  name="star"
                  size={22}
                  color={selected.pinned ? colors.accent : colors.textFaint}
                />
              </Pressable>
            ) : (
              <View style={styles.iconButton} />
            )}
          </View>

          <View style={styles.editor}>
            <TextInput
              accessibilityLabel="Note title"
              value={title}
              onChangeText={setTitle}
              placeholder="Title"
              placeholderTextColor={colors.textFaint}
              style={[styles.title, { color: colors.text }]}
            />
            <TextInput
              accessibilityLabel="Note body"
              value={body}
              onChangeText={setBody}
              multiline
              placeholder="Write"
              placeholderTextColor={colors.textFaint}
              style={[styles.body, { color: colors.text }]}
            />
          </View>

          <View style={styles.editorActions}>
            {selected?.trashed ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Restore this note"
                onPress={() => void restore()}
                style={[styles.button, { backgroundColor: colors.accentFill }]}
              >
                <Text style={[styles.buttonText, { color: colors.textInv }]}>
                  Restore
                </Text>
              </Pressable>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Save this note"
                  onPress={() => void save()}
                  style={[
                    styles.button,
                    { backgroundColor: colors.accentFill },
                  ]}
                >
                  <Text style={[styles.buttonText, { color: colors.textInv }]}>
                    Save
                  </Text>
                </Pressable>
                {selected ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Move this note to trash"
                    onPress={confirmTrash}
                    style={[styles.button, { borderColor: colors.danger }]}
                  >
                    <Text style={[styles.buttonText, { color: colors.danger }]}>
                      {DELETE_NOTE_VERB}
                    </Text>
                  </Pressable>
                ) : null}
              </>
            )}
          </View>
        </TopSafeArea>
      </Modal>
    </TopSafeArea>
  );
}
