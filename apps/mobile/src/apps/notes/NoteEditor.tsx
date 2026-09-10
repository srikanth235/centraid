// The note, open (#882): the writing surface plus the acts that belong to one
// note — where it is filed, how it is tagged, what it points at, and the one
// checklist line that leaves for Tasks.
//
// EVERY RULE HERE IS THE BLUEPRINT'S. `probeAt`/`anchorFrom` decide when `[[`
// is a live probe and what a link carries, `bodySegments` finds the checklist
// lines, and `wantsDate` decides which of them may be sent — this file draws
// those answers and derives none of them.

import React, { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import type { NotebookShelf } from "@centraid/blueprints/apps/notes/filing";
import { bodySegments } from "@centraid/blueprints/apps/notes/format";
import { anchorFrom, probeAt } from "@centraid/blueprints/apps/notes/powerbox";
import type { PassageAnchor } from "@centraid/blueprints/apps/notes/powerbox";
import { wantsDate } from "@centraid/blueprints/apps/notes/send-to-tasks";
import type {
  LinkTarget,
  NoteTag,
} from "@centraid/blueprints/apps/notes/types";
import {
  DELETE_NOTE_VERB,
  SEND_TO_TASKS,
  UNFILED_ROW,
  editorStatus,
} from "@centraid/blueprints/apps/notes/view-copy";

import Button from "../../kit/components/Button";
import { Text, TextInput } from "../../kit/components/NativeText";
import EditorRoom from "../../kit/rooms/EditorRoom";
import { TEST_IDS } from "../../kit/test-ids";
import { useTheme } from "../../kit/theme";
import { NOTES_PIN, editorTitle } from "./notes-copy";
import type { NativeNote } from "./notes-model";
import { styles } from "./NotesHome.styles";
import NotesPowerbox from "./NotesPowerbox";

export interface NoteEditorProps {
  open: boolean;
  /** Absent while the note is being written for the first time. */
  note?: NativeNote;
  title: string;
  body: string;
  tags: readonly NoteTag[];
  notebooks: readonly NotebookShelf[];
  filedIn: readonly string[];
  journalNoteIds: ReadonlySet<string>;
  onTitle: (value: string) => void;
  onBody: (value: string) => void;
  onClose: () => void;
  /** Whether the draft differs from what the vault holds. Before the first
   *  keystroke the close control is a CANCEL; after it, closing is done (D3). */
  dirty: boolean;
  /** How many versions the chain holds, for the editor's own status line. */
  versions: number;
  onTrash: () => void;
  onRestore: () => void;
  onTogglePin: () => void;
  onMove: (notebookId?: string) => void;
  onAddTag: (label: string) => void;
  onRemoveTag: (tagId: string) => void;
  onSendToTasks: (line: number, text: string) => void;
  onOpenHistory: () => void;
  onLink: (target: LinkTarget, anchor: PassageAnchor | null) => void;
}

/**
 * The acts that belong to ONE note, in the room's single foot row (#1015, D5):
 * pin, version history, and the destructive verb — or Restore, when the note
 * is in the trash and nothing else applies to it. Kit `Button`s, so the
 * destructive verb is outlined `--net` rather than a hand-rolled red plate,
 * and the disabled contract is the leaf's.
 */
function EditorActs(props: NoteEditorProps): React.JSX.Element | null {
  const note = props.note;
  if (!note) return null;
  if (note.trashed)
    return (
      <Button label="Restore" onPress={props.onRestore} variant="primary" />
    );
  return (
    <>
      <Button
        label={note.pinned ? NOTES_PIN.on : NOTES_PIN.off}
        onPress={props.onTogglePin}
        variant="quiet"
      />
      <Button
        label="Versions"
        onPress={props.onOpenHistory}
        variant="secondary"
      />
      <Button
        label={DELETE_NOTE_VERB}
        onPress={props.onTrash}
        variant="destructive"
      />
    </>
  );
}

export default function NoteEditor(
  props: NoteEditorProps
): React.JSX.Element | null {
  const { colors } = useTheme();
  const [caret, setCaret] = useState({ start: 0, end: 0 });
  const [tagDraft, setTagDraft] = useState("");
  const probe = probeAt(props.body, caret.start);
  const [linking, setLinking] = useState(false);
  const [linkTerm, setLinkTerm] = useState("");
  const note = props.note;
  const checks = bodySegments(props.body).filter(
    (segment) => segment.kind === "check"
  );

  /** The picked target replaces the live `[[…` type-in and becomes a link
   *  row; a selected passage, when there is one, travels with it. */
  const pick = (target: LinkTarget): void => {
    const anchor = anchorFrom(props.body, caret.start, caret.end);
    if (probe) {
      props.onBody(
        `${props.body.slice(0, probe.start)}[[${target.title}]]${props.body.slice(caret.start)}`
      );
    }
    props.onLink(target, anchor);
    setLinking(false);
  };

  return (
    <EditorRoom
      // AUTOSAVE MAKES THE VERB (D3): before the first keystroke nothing has
      // been written and "Cancel" is honest; after it, closing is finishing.
      cancellable={!props.dirty}
      foot={<EditorActs {...props} />}
      leaveTestID={TEST_IDS.notes.editorClose}
      onDone={props.onClose}
      presented
      title={editorTitle(note)}
      visible={props.open}
    >
      <ScrollView contentContainerStyle={styles.editor}>
        {/* The promise the blueprint has always printed, now true on this
              seat: the editor saves as you write. Drawn here rather than
              posted, because a modal presents above the root's status host. */}
        <Text style={[styles.subtitle, { color: colors.textSoft }]}>
          {editorStatus(props.versions)}
        </Text>
        <TextInput
          accessibilityLabel="Note title"
          value={props.title}
          onChangeText={props.onTitle}
          placeholder="Title"
          placeholderTextColor={colors.textFaint}
          style={[
            styles.title,
            { borderBottomColor: colors.line, color: colors.text },
          ]}
        />
        <TextInput
          accessibilityLabel="Note body"
          value={props.body}
          onChangeText={props.onBody}
          onSelectionChange={(event) => setCaret(event.nativeEvent.selection)}
          multiline
          placeholder="Write"
          placeholderTextColor={colors.textFaint}
          style={[styles.body, { color: colors.text }]}
        />

        {probe ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Link to something in your vault"
            onPress={() => {
              setLinkTerm(probe.term);
              setLinking(true);
            }}
            style={[styles.chip, { borderColor: colors.line }]}
          >
            <Text style={[styles.chipText, { color: colors.accent }]}>
              {`[[${probe.term}`}
            </Text>
          </Pressable>
        ) : null}

        {checks.length > 0 ? (
          <View style={styles.section}>
            {checks.map((segment) =>
              segment.kind === "check" ? (
                <View key={segment.line} style={styles.fieldRow}>
                  <Text
                    numberOfLines={1}
                    style={[styles.rowName, { color: colors.text }]}
                  >
                    {segment.checked ? "☑ " : "☐ "}
                    {segment.text}
                  </Text>
                  {/* Only a line naming a day, or one on `[[…]]`, earns the
                        control — `wantsDate` is the judge, not this file. */}
                  {note &&
                  wantsDate({
                    text: segment.text,
                    checked: segment.checked,
                  }) ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${SEND_TO_TASKS}: ${segment.text}`}
                      onPress={() =>
                        props.onSendToTasks(segment.line, segment.text)
                      }
                      style={[styles.chip, { borderColor: colors.line }]}
                    >
                      <Text
                        style={[styles.chipText, { color: colors.textSoft }]}
                      >
                        {SEND_TO_TASKS}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null
            )}
          </View>
        ) : null}

        {note ? (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.textFaint }]}>
              Notebook
            </Text>
            <View style={styles.controls}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`File as ${UNFILED_ROW}`}
                accessibilityState={{ selected: props.filedIn.length === 0 }}
                onPress={() => props.onMove()}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      props.filedIn.length === 0
                        ? colors.accentFill
                        : colors.bgElev,
                    borderColor: colors.line,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    {
                      color:
                        props.filedIn.length === 0
                          ? colors.textInv
                          : colors.textSoft,
                    },
                  ]}
                >
                  {UNFILED_ROW}
                </Text>
              </Pressable>
              {props.notebooks.map((shelf) => {
                const here = props.filedIn.includes(shelf.notebook_id);
                return (
                  <Pressable
                    key={shelf.notebook_id}
                    accessibilityRole="button"
                    accessibilityLabel={`Move to ${shelf.name}`}
                    accessibilityState={{ selected: here }}
                    onPress={() => props.onMove(shelf.notebook_id)}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: here
                          ? colors.accentFill
                          : colors.bgElev,
                        borderColor: colors.line,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        { color: here ? colors.textInv : colors.textSoft },
                      ]}
                    >
                      {shelf.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}

        {note ? (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.textFaint }]}>
              Tags
            </Text>
            <View style={styles.controls}>
              {props.tags.map((tag) => (
                <Pressable
                  key={tag.tag_id}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove tag ${tag.label}`}
                  onPress={() => props.onRemoveTag(tag.tag_id)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: colors.bgElev,
                      borderColor: colors.line,
                    },
                  ]}
                >
                  <Text style={[styles.chipText, { color: colors.textSoft }]}>
                    {tag.label} ×
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.fieldRow}>
              <TextInput
                accessibilityLabel="Add a tag"
                value={tagDraft}
                onChangeText={setTagDraft}
                onSubmitEditing={() => {
                  props.onAddTag(tagDraft);
                  setTagDraft("");
                }}
                placeholder="Add a tag"
                placeholderTextColor={colors.textFaint}
                style={[
                  styles.field,
                  { borderColor: colors.line, color: colors.text },
                ]}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>
      <NotesPowerbox
        open={linking}
        term={linkTerm}
        excluded={props.journalNoteIds}
        onTerm={setLinkTerm}
        onPick={pick}
        onClose={() => setLinking(false)}
      />
    </EditorRoom>
  );
}
