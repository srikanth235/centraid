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
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pressable, RefreshControl, View } from "react-native";

import {
  pendingChangeLabel,
  pendingSidecarOf,
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
  DELETE_NOTE_VERB,
  DELETE_NOTEBOOK_KEPT,
  DELETE_NOTEBOOK_VERB,
  EMPTY_DAY_ONE,
  HISTORY_NEEDS_NOTE,
  JOURNAL_ROW,
  SEARCH_COPY,
  captionFor,
  deleteNotebookBody,
  notebookDeleted,
  sentToTasks,
  shelfCopy,
} from "@centraid/blueprints/apps/notes/view-copy";
import type { ReplicaValue } from "@centraid/client/replica/native";

import { useBandOwner } from "../../kit/band/band-owner";
import { useConfirmDestructive } from "../../kit/components/ConfirmSheet";
import { NEWEST_FIRST_ANCHORING } from "../../kit/components/list-anchoring";
import { Text } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { formatRelative } from "../../kit/format";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import AppPlace from "../../kit/rooms/AppPlace";
import { parentPlace, placeStack } from "../../kit/rooms/place";
import PushedPage from "../../kit/rooms/PushedPage";
import type { RoomEmpty, RoomError } from "../../kit/rooms/room-contracts";
import { TEST_IDS } from "../../kit/test-ids";
import { useTheme } from "../../kit/theme";
import { resolveAppMeta } from "../../lib/gateway";
import type { NativeWriteResult } from "../../lib/replica/native-session-types";
import type { NotesScreenProps as NotesRouteProps } from "../../navigation";
import VaultBar from "../../screens/home/VaultBar";
import NoteEditor from "./NoteEditor";
import {
  NOTES_MORE_ROWS,
  NOTES_MORE_SHEET,
  notesBandKeyFor,
} from "./notes-band";
import type { NotesBandDestinationKey, NotesPlace } from "./notes-band";
import type { NativeNote } from "./notes-model";
import NotesBand from "./NotesBand";
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
import { useNotes } from "./useNotes";
import { useNoteVersions } from "./useNoteVersions";

/** The app's own mark and hue, from the one builtin table. */
const NOTES = resolveAppMeta({ id: "notes" });

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
  const overlay = readPendingOverlay(note.raw, pendingSidecarOf(note.raw));
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
        {/* ONE REGISTER FOR THE SEAT (#1015, S8): `today`, `yesterday`, a
            weekday inside the week, a `4 Sep` date past it — never a locale
            date string that says something different in each app. */}
        {formatRelative(note.updatedAt)}
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

/** Long enough that a sentence is one write, short enough that a member who
 *  puts the phone down mid-thought has already been saved. */
const AUTOSAVE_MS = 900;

/** The id `create-note` handed back, when the write actually reached the vault. */
function noteIdOf(result: NativeWriteResult): string | undefined {
  const output = (result as { output?: { note_id?: unknown } }).output;
  return typeof output?.note_id === "string" ? output.note_id : undefined;
}

export default function NotesHome({
  navigation,
}: NotesRouteProps): React.JSX.Element {
  const { colors } = useTheme();
  const { session, refresh } = useReplica();
  const state = useNotes();
  const { confirmDestructive, confirmSheet } = useConfirmDestructive();
  // Per app: a handback on one Notes surface is a handback on all of them.
  const { bandOwner } = useBandOwner("notes");
  const [place, setPlace] = useState<NotesPlace>(null);
  // WHERE A SUB-PLACE WAS ENTERED FROM (#1015, audit notes/findings#5). Notes
  // gets one navigator screen, so a notebook, a tag filter and the version
  // history are STATE — and state has no `goBack()`. `enter` records the
  // origin so the head can name it and return to it; every other setter
  // clears it, because a band tap is a new start, not a step deeper.
  const [origin, setOrigin] = useState<NotesPlace>();
  const enter = useCallback((next: NotesPlace, from: NotesPlace): void => {
    setOrigin(from);
    setPlace(next);
  }, []);
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

  /**
   * THE NOTE THIS SESSION JUST MINTED (#1015, D3). A new note used to be
   * written once, on close, because the seat had no id to save AGAINST: a
   * second autosave tick would have created a second note. `create-note`
   * hands the id back in its outcome, so the first save adopts it and every
   * tick after it is an edit — a new note autosaves exactly like an old one.
   * The saved text rides along, so an unchanged draft writes nothing while
   * the replica is still catching up with the row.
   */
  const [created, setCreated] = useState<
    { id: string; title: string; body: string } | undefined
  >(undefined);
  /** A save is in flight — never two creates for one draft. */
  const saving = useRef(false);
  /** A create landed without an id (queued offline): no autosave can name
   *  that note, so the draft goes back to being written once, on close. */
  const unnamed = useRef(false);

  const closeEditor = (): void => {
    setEditing(false);
    setCreating(false);
    setSelectedId(undefined);
    setCreated(undefined);
    unnamed.current = false;
    setTitle("");
    setBody("");
  };

  // AUTOSAVE, AS THE BLUEPRINT COPY ALREADY PROMISED (#1015, D3, audit
  // notes/findings#2). `editorStatus` says "Every change is saved as you
  // write" and this seat never called it: saving was a manual press, the Save
  // button looked identical whether or not there were unsaved edits, and the
  // `X` — the same gesture iOS trains members to use on a page sheet — blanked
  // the draft with no prompt and no write. A note editor holds a writing
  // session; losing it in silence is not a state this app may have.
  const dirty = editing
    ? selected
      ? title !== selected.title || body !== selected.body
      : created
        ? title !== created.title || body !== created.body
        : Boolean(title.trim() || body.trim())
    : false;

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
  ): Promise<NativeWriteResult | undefined> => {
    if (!session) return undefined;
    if (note && !note.canWrite) {
      postStatus("Read-only note — open the writable copy in its own vault.");
      return undefined;
    }
    try {
      const request = { action, input: input as ReplicaValue };
      // One open vault, so one write target (#996 wave 3). The read-only
      // refusal above is still the gate — it is the row's own answer.
      const result = await session.write("notes", request);
      const ok = surfaceWriteOutcome(result, {
        onParked: () => {
          closeEditor();
          navigation.navigate("Settings", { screen: "Approvals" });
        },
        queuedMessage: "This Notes change will sync automatically.",
        failureTitle: "Not applied",
      });
      return ok ? result : undefined;
    } catch (error) {
      surfaceWriteFailure(error, "Action failed");
      return undefined;
    }
  };

  /**
   * Save. The vault will not take a nameless note, so an untitled one is
   * named by its own first line — which is exactly what `promote` reads back
   * out, so the member never sees the derivation.
   */
  const save = async ({ closeAfter = false } = {}): Promise<void> => {
    if (saving.current) return;
    const typed = title.trim();
    const text = body.trim();
    if (!typed && !text) {
      postStatus("Write a line first.");
      return;
    }
    const name = typed || text.split("\n")[0]!.slice(0, 80);
    const body_text = text || name;
    const existingId = selected?.rawId ?? created?.id;
    saving.current = true;
    let changed: NativeWriteResult | undefined;
    try {
      changed = existingId
        ? await write("edit-note", {
            note_id: existingId,
            title: name,
            body_text,
            format: "markdown",
          })
        : await write(
            "create-note",
            {
              title: name,
              body_text,
              format: "markdown",
              ...(notebookId ? { notebook_id: notebookId } : {}),
            },
            undefined
          );
    } finally {
      saving.current = false;
    }
    if (!changed) return;
    // A queued write has no output yet; that note keeps the old shape and is
    // written once more on close rather than adopted mid-flight.
    const mintedId = noteIdOf(changed);
    const savedId = existingId ?? mintedId;
    if (savedId) {
      setCreated({ id: savedId, title: name, body: body_text });
      if (mintedId && !selectedId) setSelectedId(mintedId);
    } else unnamed.current = true;
    if (closeAfter) closeEditor();
  };

  // The debounce saves a NEW note too (#1015): the first tick creates it, the
  // outcome hands the id back, and every tick after it is an edit of that row.
  // `saving` is what makes that safe — two ticks can never both create. A
  // create that landed without an id (queued offline) sets `unnamed` and the
  // draft goes back to being written once, on close.
  // `save` is rebuilt every render over the current draft, so the timer holds
  // the latest through a ref rather than through a dependency that would reset
  // it on every keystroke's re-render and therefore never fire.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    if (!editing || !dirty || unnamed.current) return undefined;
    const timer = setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [editing, dirty, selectedId, title, body]);

  const editorVersions = useNoteVersions({
    headContentId: selected?.bodyContentId ?? "",
    currentRevisionId: selected?.currentRevisionId ?? null,
    noteId: selected?.rawId ?? "",
    createdAt: selected?.createdAt ?? "",
    ...state.chainRows,
  });

  /** Closing IS finishing (D3): the draft goes to the vault, then the sheet
   *  goes away. Nothing is discarded and nothing is asked. */
  const finishEditing = (): void => {
    if (dirty) void save({ closeAfter: true });
    else closeEditor();
  };

  const confirmTrash = (): void => {
    if (!selected) return;
    // ONE CONFIRM SHAPE (#1015, S7): the noun and the count are in the title,
    // the destructive verb is outlined `--net`, and the 30-day reassurance is
    // the body — in the words the spec gives it, shared with the web seat.
    confirmDestructive({
      body: DELETE_NOTE_BODY,
      noun: "note",
      onConfirm: () => {
        void write("delete-note", { note_id: selected.rawId }).then((done) => {
          if (done) closeEditor();
        });
      },
      verb: DELETE_NOTE_VERB,
    });
  };

  /** A notebook is pure structure: its notes are unfiled, never destroyed,
   *  and the confirm says how many before it happens. */
  const confirmDeleteNotebook = (book: NotebookShelf): void => {
    const orphaned = book.noteIds.length;
    confirmDestructive({
      body: `${deleteNotebookBody(orphaned)} ${DELETE_NOTEBOOK_KEPT}`,
      noun: "notebook",
      onConfirm: () => {
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
      verb: DELETE_NOTEBOOK_VERB,
    });
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

  // The rows only. Every other state — a failed read, an empty shelf — is the
  // room's (`RoomBody`), in the one order every surface now keeps.
  const list = (
    <FlashList
      maintainVisibleContentPosition={NEWEST_FIRST_ANCHORING}
      data={visible}
      keyExtractor={(note) => note.id}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void pull()} />
      }
      renderItem={({ item, index }) => (
        <NoteRow
          note={item}
          first={index === 0}
          onOpen={() => openNote(item)}
        />
      )}
    />
  );

  // Assignments, not an IIFE with returns: the first `return (<` in this
  // component has to be the room it is rooted in (`lint-mobile-rooms`).
  let pane: React.JSX.Element = list;
  if (place === NOTES_MORE_SHEET)
    pane = (
      <MoreSheet
        rows={NOTES_MORE_ROWS}
        onPick={(shelfId) => enter(shelfId, NOTES_MORE_SHEET)}
      />
    );
  if (place === BOOKS)
    pane = (
      <NotebooksPlace
        notebooks={state.notebooks}
        unfiled={
          unfiledNoteIds([...state.visibleNoteIds], state.notebooks).length
        }
        onOpen={(id) => enter(notebookShelf(id), BOOKS)}
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
  else if (place === TAGS)
    pane = (
      <TagsPlace
        tags={state.tagShelves}
        {...(conceptId ? { active: conceptId } : {})}
        onSelect={(id) => {
          setConceptId(id);
          enter(null, TAGS);
        }}
      />
    );
  else if (place === TRASH)
    pane = (
      <TrashPlace
        notes={visible}
        onRestore={(note) => {
          void write("restore-note", { note_id: note.rawId }, note);
        }}
      />
    );
  else if (place === HISTORY && selected)
    pane = (
      <NotesHistory
        note={selected}
        chainRows={state.chainRows}
        onRestore={(contentId) => {
          // RESTORING APPENDS: the chain grows a head, nothing is rewritten.
          void write("restore-note-version", {
            note_id: selected.rawId,
            content_id: contentId,
          });
        }}
      />
    );
  else if (place === CAPTURE)
    pane = <CapturePlace onScan={() => navigation.navigate("Scan")} />;
  else if (place === VOICE) pane = <VoicePlace />;

  const caption = captionFor(shelf);
  // The notebook's own NAME, not the generic noun: `shelfCopy` takes it and
  // Notes never passed it (#1015, audit notes/findings#5).
  const notebookName = notebookId
    ? state.notebooks.find((book) => book.notebook_id === notebookId)?.name
    : undefined;
  const placeTitle =
    place === NOTES_MORE_SHEET ? "More" : shelfCopy(shelf, notebookName).title;
  const originTitle =
    origin === undefined
      ? ""
      : origin === NOTES_MORE_SHEET
        ? "More"
        : shelfCopy(origin).title;

  // WHERE THIS SCREEN IS, AS A VALUE (#1015, B7). Notes has one navigator
  // entry, so its stack is the two places it holds in state — the origin a
  // sub-place was entered from, and the sub-place itself. `parentPlace` reads
  // the back target off that; no caller writes the word down.
  const stack = placeStack(
    origin === undefined
      ? [{ key: String(place), title: placeTitle }]
      : [
          { key: String(origin), title: originTitle },
          { key: String(place), title: placeTitle },
        ]
  );
  const backTo = parentPlace(stack);

  const unreachable = state.connection === "unavailable";
  // ERROR OUTRANKS EMPTY (`RoomBody`): a shelf that could not be read is not
  // an empty shelf, and Notes used to draw both at once.
  const roomError: RoomError | undefined =
    unreachable || state.error
      ? {
          body: unreachable
            ? (state.unavailableReason ?? "Pair or reconnect a gateway.")
            : (state.error ?? ""),
          retry: { label: "Retry", onPress: () => void refresh?.() },
          title: unreachable
            ? "Notes is not connected"
            : "Notes could not be loaded",
        }
      : undefined;

  const startNote = (): void => {
    setCreating(true);
    setSelectedId(undefined);
    setTitle("");
    setBody("");
    setEditing(true);
  };

  /** The empty state of whichever place is showing; the blueprint's own words
   *  where it has them (`SEARCH_COPY`), which this seat never used. */
  let roomEmpty: RoomEmpty | undefined;
  if (place === HISTORY && !selected)
    roomEmpty = {
      body: "Open a note to walk its chain.",
      routine: true,
      title: HISTORY_NEEDS_NOTE,
    };
  else if (pane === list && visible.length === 0) {
    if (place === SEARCH)
      roomEmpty = term
        ? {
            body: SEARCH_COPY.miss.body,
            routine: true,
            title: SEARCH_COPY.miss.title(query.trim()),
          }
        : {
            body: SEARCH_COPY.resting.body,
            routine: true,
            title: SEARCH_COPY.resting.title,
          };
    else if (place === JOURNAL)
      roomEmpty = {
        body: JOURNAL_ROW,
        routine: true,
        title: "No journal entries yet",
      };
    else if (place === TRASH)
      roomEmpty = {
        body: DELETE_NOTE_BODY,
        routine: true,
        title: "Trash is empty",
      };
    else
      // No action here: the room's own header already carries "New note", and
      // two doors with the same word is the duplication the empty was built to
      // avoid, not an extra affordance.
      roomEmpty = {
        body: EMPTY_DAY_ONE,
        title: "Nothing written yet",
      };
  }

  const content = (
    <>
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
    </>
  );

  const editor = (
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
      onClose={finishEditing}
      dirty={dirty}
      versions={editorVersions.length}
      onTrash={confirmTrash}
      onRestore={() => {
        if (!selected) return;
        void write("restore-note", { note_id: selected.rawId }).then((done) => {
          if (done) closeEditor();
        });
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
        enter(HISTORY, place);
      }}
      onLink={(target, anchor) => void link(target, anchor)}
    />
  );
  const overlay = (
    <>
      {editor}
      {confirmSheet}
    </>
  );

  // The vault lockup, then the replica's own line: the two facts true on every
  // route of an app, above the header and outside the body so neither scrolls.
  const chrome = (
    <>
      <VaultBar />
      <ReplicaStatusBar />
    </>
  );
  const band = (): React.JSX.Element => (
    <NotesBand
      owner={bandOwner}
      current={notesBandKeyFor(place)}
      onSelect={(key: NotesBandDestinationKey) => {
        setOrigin(undefined);
        setPlace(PLACE_FOR_TAB[key]);
        if (key !== "library") setConceptId(undefined);
      }}
      onHome={() => navigation.navigate("Home")}
    />
  );
  const search =
    place === SEARCH
      ? {
          accessibilityLabel: "Search notes",
          onChangeText: setQuery,
          placeholder: "Search titles and bodies",
          value: query,
        }
      : undefined;
  const newNote = {
    label: "New note",
    onPress: startNote,
    testID: TEST_IDS.notes.capture,
  };

  // A place entered FROM another place is a pushed page, and its back control
  // names the place it descends from rather than the word "Back".
  if (backTo)
    return (
      <PushedPage
        action={newNote}
        backTo={backTo}
        band={band}
        chrome={chrome}
        {...(roomEmpty ? { empty: roomEmpty } : {})}
        {...(roomError ? { error: roomError } : {})}
        onBack={() => {
          setPlace(origin ?? null);
          setOrigin(undefined);
          if (origin === TAGS) setConceptId(undefined);
        }}
        overlay={overlay}
        {...(search ? { search } : {})}
        title={placeTitle}
      >
        {content}
      </PushedPage>
    );
  return (
    <AppPlace
      action={newNote}
      app={{
        color: NOTES.color,
        iconKey: NOTES.iconKey,
        title: placeTitle,
        ...(caption ? { subtitle: caption } : {}),
      }}
      band={band}
      chrome={chrome}
      {...(roomEmpty ? { empty: roomEmpty } : {})}
      {...(roomError ? { error: roomError } : {})}
      onBack={() => navigation.navigate("Home")}
      overlay={overlay}
      {...(search ? { search } : {})}
    >
      {content}
    </AppPlace>
  );
}
