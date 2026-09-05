// The places and acts that are lists of rows rather than lists of notes
// (#882): the notebook spine, the tag vocabulary, the trash, the More sheet,
// and the two origin acts.
//
// Every row here reads the blueprint's own words (`view-copy.ts`) and the
// blueprint's own projections (`filing.ts`); nothing on this seat names a
// notebook, a tag or a countdown in a second spelling.

import React, { useState } from "react";
import { Pressable, View } from "react-native";

import type {
  NotebookShelf,
  TagShelf,
} from "@centraid/blueprints/apps/notes/filing";
import { daysLeft } from "@centraid/blueprints/apps/notes/format";
import type { ShelfId } from "@centraid/blueprints/apps/notes/shelves";
import {
  CAPTURE_CUSTODY,
  CAPTURE_SCANNER,
  CAPTURE_WHAT,
  RAIL_NOTEBOOKS,
  RAIL_TAGS,
  TRASH_STATUS,
  UNFILED_NOTE,
  UNFILED_ROW,
  VOICE_AUDIO_READABLE,
  VOICE_NO_TRANSCRIPT_YET,
} from "@centraid/blueprints/apps/notes/view-copy";

import Icon from "../../kit/components/Icon";
import { NEWEST_FIRST_ANCHORING } from "../../kit/components/list-anchoring";
import { Text, TextInput } from "../../kit/components/NativeText";
import SeatList from "../../kit/components/SeatList";
import { useTheme } from "../../kit/theme";
import type { NotesMoreRow } from "./notes-band";
import type { NativeNote } from "./notes-model";
import { styles } from "./NotesHome.styles";

/** Create and rename are the same control at two moments. */
function NameField({
  initial,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const [value, setValue] = useState(initial);
  return (
    <View style={styles.fieldRow}>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={setValue}
        onSubmitEditing={() => onCommit(value)}
        autoFocus
        placeholder="Notebook name"
        placeholderTextColor={colors.textFaint}
        style={[styles.field, { borderColor: colors.line, color: colors.text }]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save this name"
        onPress={() => onCommit(value)}
        style={[styles.button, { backgroundColor: colors.accentFill }]}
      >
        <Text style={[styles.buttonText, { color: colors.textInv }]}>Save</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        onPress={onCancel}
        style={styles.iconButton}
      >
        <Icon name="x" size={20} color={colors.textSoft} />
      </Pressable>
    </View>
  );
}

export interface NotebooksPlaceProps {
  notebooks: readonly NotebookShelf[];
  unfiled: number;
  onOpen: (notebookId: string) => void;
  onCreate: (name: string) => void;
  onRename: (notebookId: string, name: string) => void;
  onDelete: (shelf: NotebookShelf) => void;
}

/** The spine of the library: one row per notebook, its count, and the two
 *  acts that change it. Unfiled is a row here because an unfiled note is not
 *  a lost one. */
export function NotebooksPlace(props: NotebooksPlaceProps): React.JSX.Element {
  const { colors } = useTheme();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const head = (
    <View>
      <Text style={[styles.rowMeta, { color: colors.textSoft }]}>
        {RAIL_NOTEBOOKS}
      </Text>
      {creating ? (
        <NameField
          initial=""
          label="Notebook name"
          onCommit={(name) => {
            setCreating(false);
            props.onCreate(name);
          }}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New notebook"
          onPress={() => setCreating(true)}
          style={[styles.button, { backgroundColor: colors.accentFill }]}
        >
          <Icon name="plus" size={18} color={colors.textInv} />
          <Text style={[styles.buttonText, { color: colors.textInv }]}>
            New notebook
          </Text>
        </Pressable>
      )}
      <View style={[styles.row, { borderBottomColor: colors.line }]}>
        <View style={styles.rowOpen}>
          <Text style={[styles.rowName, { color: colors.text }]}>
            {UNFILED_ROW}
          </Text>
          <Text style={[styles.rowMeta, { color: colors.textFaint }]}>
            {UNFILED_NOTE}
          </Text>
        </View>
        <Text style={[styles.count, { color: colors.textFaint }]}>
          {props.unfiled}
        </Text>
      </View>
    </View>
  );
  return (
    <SeatList
      accessibilityLabel={RAIL_NOTEBOOKS}
      anchoring={NEWEST_FIRST_ANCHORING}
      rows={props.notebooks}
      keyOf={(shelf) => shelf.notebook_id}
      contentContainerStyle={styles.list}
      header={head}
      renderRow={(shelf) =>
        renaming === shelf.notebook_id ? (
          <NameField
            initial={shelf.name ?? ""}
            label="Notebook name"
            onCommit={(name) => {
              setRenaming(undefined);
              props.onRename(shelf.notebook_id, name);
            }}
            onCancel={() => setRenaming(undefined)}
          />
        ) : (
          <View style={[styles.row, { borderBottomColor: colors.line }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${shelf.name ?? "this notebook"}`}
              onPress={() => props.onOpen(shelf.notebook_id)}
              style={styles.rowOpen}
            >
              <Text style={[styles.rowName, { color: colors.text }]}>
                {shelf.name}
              </Text>
            </Pressable>
            <Text style={[styles.count, { color: colors.textFaint }]}>
              {shelf.noteIds.length}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Rename ${shelf.name ?? "this notebook"}`}
              onPress={() => setRenaming(shelf.notebook_id)}
              style={styles.iconButton}
            >
              <Icon name="edit-2" size={19} color={colors.textSoft} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete ${shelf.name ?? "this notebook"}`}
              onPress={() => props.onDelete(shelf)}
              style={styles.iconButton}
            >
              <Icon name="trash-2" size={19} color={colors.danger} />
            </Pressable>
          </View>
        )
      }
    />
  );
}

export interface TagsPlaceProps {
  tags: readonly TagShelf[];
  active?: string;
  onSelect: (conceptId?: string) => void;
}

/** Tags are a LENS: a row narrows the library rather than standing as a place
 *  a note could be moved into. */
export function TagsPlace(props: TagsPlaceProps): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <SeatList
      accessibilityLabel={RAIL_TAGS}
      anchoring={NEWEST_FIRST_ANCHORING}
      rows={props.tags}
      keyOf={(tag) => tag.concept_id}
      contentContainerStyle={styles.list}
      header={
        <Text style={[styles.rowMeta, { color: colors.textSoft }]}>
          {RAIL_TAGS}
        </Text>
      }
      renderRow={(tag) => (
        <View style={[styles.row, { borderBottomColor: colors.line }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: props.active === tag.concept_id }}
            accessibilityLabel={`Show notes tagged ${tag.label}`}
            onPress={() =>
              props.onSelect(
                props.active === tag.concept_id ? undefined : tag.concept_id
              )
            }
            style={styles.rowOpen}
          >
            <Text style={[styles.rowName, { color: colors.text }]}>
              {tag.label}
            </Text>
          </Pressable>
          <Text style={[styles.count, { color: colors.textFaint }]}>
            {tag.edges.length}
          </Text>
        </View>
      )}
    />
  );
}

export interface TrashPlaceProps {
  notes: readonly NativeNote[];
  onRestore: (note: NativeNote) => void;
}

/** The countdown is the vault's, read off `purge_at` — never a number this
 *  seat invents, and absent rather than guessed when the row carries none. */
export function TrashPlace(props: TrashPlaceProps): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <SeatList
      accessibilityLabel={TRASH_STATUS}
      anchoring={NEWEST_FIRST_ANCHORING}
      rows={props.notes}
      keyOf={(note) => note.id}
      contentContainerStyle={styles.list}
      header={
        <Text style={[styles.rowMeta, { color: colors.textSoft }]}>
          {TRASH_STATUS}
        </Text>
      }
      renderRow={(note) => {
        const left = daysLeft(note.purgeAt);
        return (
          <View style={[styles.row, { borderBottomColor: colors.line }]}>
            <View style={styles.rowOpen}>
              <Text
                numberOfLines={1}
                style={[styles.rowName, { color: colors.text }]}
              >
                {note.title}
              </Text>
              {left === null ? null : (
                <Text style={[styles.rowMeta, { color: colors.textFaint }]}>
                  {left} days left
                </Text>
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Restore ${note.title}`}
              onPress={() => props.onRestore(note)}
              style={[styles.chip, { borderColor: colors.line }]}
            >
              <Text style={[styles.chipText, { color: colors.textSoft }]}>
                Restore
              </Text>
            </Pressable>
          </View>
        );
      }}
    />
  );
}

export interface MoreSheetProps {
  rows: readonly NotesMoreRow[];
  onPick: (shelf: ShelfId) => void;
}

export function MoreSheet(props: MoreSheetProps): React.JSX.Element {
  const { colors } = useTheme();
  // The shelves are few, but the row COUNT is not what E6 is about: the pin in
  // `scripts/accessibility-contract.test.mjs` names this file, and a screen
  // that keeps one hand-wired `.map()` beside three `SeatList`s is the drift a
  // per-file pin cannot see.
  return (
    <SeatList
      accessibilityLabel="More places"
      anchoring={NEWEST_FIRST_ANCHORING}
      rows={props.rows}
      keyOf={(row) => String(row.shelf)}
      contentContainerStyle={styles.list}
      renderRow={(row) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={row.label}
          onPress={() => props.onPick(row.shelf)}
          style={[styles.row, { borderBottomColor: colors.line }]}
        >
          <Icon name={row.icon} size={19} color={colors.textSoft} />
          <View style={styles.rowOpen}>
            <Text style={[styles.rowName, { color: colors.text }]}>
              {row.label}
            </Text>
            {row.meta ? (
              <Text style={[styles.rowMeta, { color: colors.textFaint }]}>
                {row.meta}
              </Text>
            ) : null}
          </View>
        </Pressable>
      )}
    />
  );
}

/** Capture hands off to the frame's own Scan cover, which already owns the
 *  camera permission and the on-device review. */
export function CapturePlace({
  onScan,
}: {
  onScan: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={styles.empty}>
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
        onPress={onScan}
        style={[styles.button, { backgroundColor: colors.accentFill }]}
      >
        <Text style={[styles.buttonText, { color: colors.textInv }]}>
          Open the camera
        </Text>
      </Pressable>
    </View>
  );
}

/** No recorder on this seat. The sentence stands where a dead control would
 *  otherwise sit. */
export function VoicePlace(): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>
        {VOICE_NO_TRANSCRIPT_YET}
      </Text>
      <Text style={[styles.emptyBody, { color: colors.textSoft }]}>
        {VOICE_AUDIO_READABLE}
      </Text>
    </View>
  );
}
