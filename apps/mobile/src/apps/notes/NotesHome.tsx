/*! governance: allow-repo-hygiene file-size-limit — the native Notes cover keeps its places, its list and its one write door in a single focus-contained screen so a write outcome cannot be silently orphaned. */
// Notes, the native cover (Notes spec §1, §2; #882).
//
// WHAT THIS SEAT IS. A native cover over the SAME replica the web app reads,
// drawn to the same spec and sharing its pure logic: `promote`, `probeAt`, the
// shelf table, the notebook and tag projections and the version walk are all
// imported, so no rule means two things on two seats.
//
// NOTES CLAIMS THE BAND (#882): its four places are `BAND_DESTINATIONS`, and
// Capture, Voice, Tags, Trash and Version history are ACTS behind More. The
// navigator has ONE Notes route, so a destination is state, not a pushed entry.
import { FlashList } from "@shopify/flash-list";
import React, { useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, View } from "react-native";

import {
  pendingChangeLabel,
  readPendingOverlay,
} from "@centraid/blueprints/apps/_shared/pending-overlay";
import {
  notebookIdsOfNote,
  tagsOfNote,
  unfiledNoteIds,
} from "@centraid/blueprints/apps/notes/filing";
import type { NotebookShelf } from "@centraid/blueprints/apps/notes/filing";
import { promote } from "@centraid/blueprints/apps/notes/format";
import type { PassageAnchor } from "@centraid/blueprints/apps/notes/powerbox";
import { sendToTasksPayload } from "@centraid/blueprints/apps/notes/send-to-tasks";
import {
  BOOKS,
  CAPTURE,
  HISTORY,
  JOURNAL,
  SEARCH,
  TAGS,
  TRASH,
  VOICE,
  notebookIdFrom,
  notebookShelf,
} from "@centraid/blueprints/apps/notes/shelves";
import type { ShelfId } from "@centraid/blueprints/apps/notes/shelves";
import type { LinkTarget } from "@centraid/blueprints/apps/notes/types";
import {
  DELETE_NOTE_BODY,
  DELETE_NOTE_TITLE,
  DELETE_NOTE_VERB,
  DELETE_NOTEBOOK_KEPT,
  DELETE_NOTEBOOK_VERB,
  EMPTY_DAY_ONE,
  HISTORY_NEEDS_NOTE,
  JOURNAL_ROW,
  SEARCH_EMPTY,
  captionFor,
  deleteNotebookBody,
  deleteNotebookTitle,
  notebookDeleted,
  searchNoMatch,
  sentToTasks,
  shelfCopy,
} from "@centraid/blueprints/apps/notes/view-copy";
import type { ReplicaValue } from "@centraid/client/replica/native";

import Icon from "../../kit/components/Icon";
import { NEWEST_FIRST_ANCHORING } from "../../kit/components/list-anchoring";
import { Text, TextInput } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { TEST_IDS } from "../../kit/test-ids";
import { useTheme } from "../../kit/theme";
import type { NotesScreenProps as NotesRouteProps } from "../../navigation";
import NoteEditor from "./NoteEditor";
import {
  NOTES_MORE_ROWS,
  NOTES_MORE_SHEET,
  notesBandKeyFor,
} from "./notes-band";
import type { NotesBandDestinationKey, NotesPlace } from "./notes-band";
import type { NativeNote } from "./notes-model";
import NotesHistory from "./NotesHistory";
import { styles } from "./NotesHome.styles";
import {
  CapturePlace,
  MoreSheet,
  NotebooksPlace,
  TagsPlace,
  TrashPlace,
  VoicePlace,
} from "./NotesPlaces";
import NotesScreen from "./NotesScreen";
import { useNotes } from "./useNotes";

const PLACE_FOR_TAB: Readonly<Record<NotesBandDestinationKey, NotesPlace>> = {
  library: null,
  books: BOOKS,
  journal: JOURNAL,
  search: SEARCH,
  more: NOTES_MORE_SHEET,
};

/** One row of the reading room. The heading is `promote`'s — a note with no
 *  title of its own shows its first line, and the preview picks up below. */
function NoteRow({
  note,
  first,
  onOpen,
}: {
  note: NativeNote;
  /** The leading row of the reading room; only it carries a handle. */
  first: boolean;
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
      testID={first ? TEST_IDS.notes.rowFirst : undefined}
      style={[styles.note, { borderBottomColor: colors.line }]}
    >
      <Text
        numberOfLines={1}
        style={[styles.noteTitle, { color: colors.text }]}
      >
        {note.pinned ? "★ " : ""}
        {shown.heading}
      </Text>
      {/* The preview is the note's BODY, a SECOND replica read joined to the row
          on device — so it gets a handle of its own. A dropped join is headings
          above empty previews, and nothing else on this row can see that. */}
      {shown.preview ? (
        <Text
          numberOfLines={2}
          testID={first ? TEST_IDS.notes.rowFirstPreview : undefined}
          style={[styles.notePreview, { color: colors.textSoft }]}
        >
          {shown.preview.replaceAll("\n", " ")}
        </Text>
      ) : null}
      <Text style={[styles.noteMeta, { color: colors.textFaint }]}>
        {new Date(note.updatedAt).toLocaleDateString()}
        {note.references.length ? ` · ${note.references.length} links` : ""}
      </Text>
      {/* A queued write says where it is, on the row it changed. */}
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
}: NotesRouteProps): React.JSX.Element {
  const { colors } = useTheme();
  const { session, refresh } = useReplica();
  const state = useNotes();
  const [place, setPlace] = useState<NotesPlace>(null);
  const [conceptId, setConceptId] = useState<string>();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const shelf: ShelfId = place === NOTES_MORE_SHEET ? null : place;
  const notebookId = notebookIdFrom(shelf);
  const term = query.trim().toLowerCase();
  // The LIVE row, never a captured copy: after a restore the chain has a new
  // head, and a held snapshot would keep History walking the old one.
  const selected = state.notes.find((note) => note.id === selectedId);

  // JOURNAL IS A PLACE, NEVER AN INTERLEAVE (R-journal): the marker set leaves
  // the library, the search and the trash, and the Journal place is the only
  // surface that shows it. Opening one by id still works.
  const visible = useMemo(() => {
    const journal = state.journalNoteIds;
    return state.notes.filter((note) => {
      const isJournal = journal.has(note.rawId);
      if (place === JOURNAL) return isJournal && !note.trashed;
      if (isJournal) return false;
      if (place === TRASH) return note.trashed;
      if (note.trashed) return false;
      if (
        notebookId &&
        !notebookIdsOfNote(note.rawId, state.notebooks).includes(notebookId)
      )
        return false;
      if (
        conceptId &&
        !tagsOfNote(note.rawId, state.tagShelves).some(
          (tag) => tag.concept_id === conceptId
        )
      )
        return false;
      if (place === SEARCH) {
        if (!term) return false;
        const shown = promote({ title: note.title, body: note.body });
        return `${shown.heading} ${shown.preview}`.toLowerCase().includes(term);
      }
      return true;
    });
  }, [
    conceptId,
    notebookId,
    place,
    state.journalNoteIds,
    state.notebooks,
    state.notes,
    state.tagShelves,
    term,
  ]);

  const closeEditor = (): void => {
    setEditing(false);
    setCreating(false);
    setSelectedId(undefined);
    setTitle("");
    setBody("");
  };

  const openNote = (note: NativeNote): void => {
    setSelectedId(note.id);
    setCreating(false);
    setTitle(note.title);
    setBody(note.body);
    setEditing(true);
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
          {
            title: name,
            body_text: text || name,
            format: "markdown",
            ...(notebookId ? { notebook_id: notebookId } : {}),
          },
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

  /** A notebook is pure structure: its notes are unfiled, never destroyed,
   *  and the confirm says how many before it happens. */
  const confirmDeleteNotebook = (book: NotebookShelf): void => {
    const orphaned = book.noteIds.length;
    Alert.alert(
      deleteNotebookTitle(book.name ?? "Notebook"),
      `${deleteNotebookBody(orphaned)} ${DELETE_NOTEBOOK_KEPT}`,
      [
        { text: "Keep it", style: "cancel" },
        {
          text: DELETE_NOTEBOOK_VERB,
          style: "destructive",
          onPress: () => {
            void write(
              "delete-notebook",
              { notebook_id: book.notebook_id },
              undefined
            ).then((done) => {
              if (!done) return;
              postStatus(notebookDeleted(orphaned));
              if (notebookId === book.notebook_id) setPlace(BOOKS);
            });
          },
        },
      ]
    );
  };

  const sendToTasks = async (line: number, text: string): Promise<void> => {
    if (!selected) return;
    const payload = sendToTasksPayload({
      noteId: selected.rawId,
      line,
      text,
    });
    // MINTED IN TASKS AND LINKED BACK, never copied: nothing about the line is
    // stored here afterwards — the point of the gesture is that it LEAVES.
    const done = await write("send-to-tasks", {
      title: payload.title,
      ...(payload.due_at ? { due_at: payload.due_at } : {}),
      note_id: payload.note_id,
      exact: payload.exact,
    });
    if (done) postStatus(sentToTasks(payload.title));
  };

  const link = async (
    target: LinkTarget,
    anchor: PassageAnchor | null
  ): Promise<void> => {
    if (!selected) return;
    await write("link", {
      note_id: selected.rawId,
      target_type: target.type,
      target_id: target.id,
      ...(anchor
        ? {
            exact: anchor.exact,
            prefix: anchor.prefix,
            suffix: anchor.suffix,
            start: anchor.start,
          }
        : {}),
    });
  };

  const pull = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refresh?.();
    } finally {
      setRefreshing(false);
    }
  };

  const list = (
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
          maintainVisibleContentPosition={NEWEST_FIRST_ANCHORING}
          data={visible}
          keyExtractor={(note) => note.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void pull()}
            />
          }
          renderItem={({ item, index }) => (
            <NoteRow
              note={item}
              first={index === 0}
              onOpen={() => openNote(item)}
            />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={[styles.emptyTitle, { color: colors.text }]}>
                {place === SEARCH
                  ? term
                    ? searchNoMatch(query.trim())
                    : SEARCH_EMPTY
                  : EMPTY_DAY_ONE}
              </Text>
              {place === JOURNAL ? (
                <Text style={[styles.emptyBody, { color: colors.textSoft }]}>
                  {JOURNAL_ROW}
                </Text>
              ) : null}
            </View>
          }
        />
      ) : null}
    </>
  );

  const pane = ((): React.JSX.Element => {
    if (place === NOTES_MORE_SHEET)
      return <MoreSheet rows={NOTES_MORE_ROWS} onPick={setPlace} />;
    if (place === BOOKS)
      return (
        <NotebooksPlace
          notebooks={state.notebooks}
          unfiled={
            unfiledNoteIds([...state.visibleNoteIds], state.notebooks).length
          }
          onOpen={(id) => setPlace(notebookShelf(id))}
          onCreate={(name) => {
            if (name.trim())
              void write("create-notebook", { name: name.trim() }, undefined);
          }}
          onRename={(id, name) => {
            if (name.trim())
              void write(
                "rename-notebook",
                { notebook_id: id, name: name.trim() },
                undefined
              );
          }}
          onDelete={confirmDeleteNotebook}
        />
      );
    if (place === TAGS)
      return (
        <TagsPlace
          tags={state.tagShelves}
          {...(conceptId ? { active: conceptId } : {})}
          onSelect={(id) => {
            setConceptId(id);
            setPlace(null);
          }}
        />
      );
    if (place === TRASH)
      return (
        <TrashPlace
          notes={visible}
          onRestore={(note) => {
            void write("restore-note", { note_id: note.rawId }, note);
          }}
        />
      );
    if (place === HISTORY)
      return selected ? (
        <NotesHistory
          note={selected}
          chainRows={state.chainRows}
          unreadable={
            state.error !== undefined || state.connection === "unavailable"
          }
          onRestore={(contentId) => {
            // RESTORING APPENDS: the chain grows a head, nothing is rewritten.
            void write("restore-note-version", {
              note_id: selected.rawId,
              content_id: contentId,
            });
          }}
        />
      ) : (
        <View style={styles.empty}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {HISTORY_NEEDS_NOTE}
          </Text>
        </View>
      );
    if (place === CAPTURE)
      return <CapturePlace onScan={() => navigation.navigate("Scan")} />;
    if (place === VOICE) return <VoicePlace />;
    return list;
  })();

  const caption = captionFor(shelf);
  return (
    <NotesScreen
      current={notesBandKeyFor(place)}
      onDestination={(key) => {
        setPlace(PLACE_FOR_TAB[key]);
        if (key !== "library") setConceptId(undefined);
      }}
      onHome={() => navigation.navigate("Home")}
    >
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            {place === NOTES_MORE_SHEET ? "More" : shelfCopy(shelf).title}
          </Text>
          {caption ? (
            <Text style={[styles.subtitle, { color: colors.textSoft }]}>
              {caption}
            </Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New note"
          testID={TEST_IDS.notes.capture}
          onPress={() => {
            setCreating(true);
            setSelectedId(undefined);
            setTitle("");
            setBody("");
            setEditing(true);
          }}
          style={styles.iconButton}
        >
          <Icon name="plus" size={24} color={colors.accent} />
        </Pressable>
      </View>
      <ReplicaStatusBar />

      {place === SEARCH ? (
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

      {conceptId && place === null ? (
        <View style={styles.controls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear the tag filter"
            onPress={() => setConceptId(undefined)}
            style={[
              styles.chip,
              { backgroundColor: colors.accentFill, borderColor: colors.line },
            ]}
          >
            <Text style={[styles.chipText, { color: colors.textInv }]}>
              {`${
                state.tagShelves.find((tag) => tag.concept_id === conceptId)
                  ?.label ?? "tag"
              } ×`}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {pane}

      <NoteEditor
        open={editing && (creating || selected !== undefined)}
        {...(selected ? { note: selected } : {})}
        title={title}
        body={body}
        tags={selected ? tagsOfNote(selected.rawId, state.tagShelves) : []}
        notebooks={state.notebooks}
        filedIn={
          selected ? notebookIdsOfNote(selected.rawId, state.notebooks) : []
        }
        journalNoteIds={state.journalNoteIds}
        onTitle={setTitle}
        onBody={setBody}
        onClose={closeEditor}
        onSave={() => void save()}
        onTrash={confirmTrash}
        onRestore={() => {
          if (!selected) return;
          void write("restore-note", { note_id: selected.rawId }).then(
            (done) => {
              if (done) closeEditor();
            }
          );
        }}
        onTogglePin={() => {
          if (!selected) return;
          void write("edit-note", {
            note_id: selected.rawId,
            pinned: selected.pinned ? 0 : 1,
          });
        }}
        onMove={(target) => {
          if (!selected) return;
          // `move-note` with no notebook is the vault's way of saying unfiled.
          void write("move-note", {
            note_id: selected.rawId,
            ...(target ? { notebook_id: target } : {}),
          });
        }}
        onAddTag={(label) => {
          if (!selected || !label.trim()) return;
          void write("add-tag", {
            note_id: selected.rawId,
            label: label.trim(),
          });
        }}
        onRemoveTag={(tagId) => {
          // ONE EDGE, never the concept: other notes keep the tag.
          void write("remove-tag", { tag_id: tagId });
        }}
        onSendToTasks={(line, text) => void sendToTasks(line, text)}
        onOpenHistory={() => {
          setEditing(false);
          setPlace(HISTORY);
        }}
        onLink={(target, anchor) => void link(target, anchor)}
      />
    </NotesScreen>
  );
}
