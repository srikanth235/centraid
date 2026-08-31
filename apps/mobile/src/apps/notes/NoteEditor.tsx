// The note, open (#882): the writing surface plus the acts that belong to one
// note — where it is filed, how it is tagged, what it points at, and the one
// checklist line that leaves for Tasks.
//
// EVERY RULE HERE IS THE BLUEPRINT'S. `probeAt`/`anchorFrom` decide when `[[`
// is a live probe and what a link carries, `bodySegments` finds the checklist
// lines, and `wantsDate` decides which of them may be sent — this file draws
// those answers and derives none of them.

import React, { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

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
} from "@centraid/blueprints/apps/notes/view-copy";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { TEST_IDS } from "../../kit/test-ids";
import { useTheme } from "../../kit/theme";
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
  onSave: () => void;
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

export default function NoteEditor(props: NoteEditorProps): React.JSX.Element {
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
    <Modal
      visible={props.open}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <TopSafeArea
        accessibilityViewIsModal
        style={[styles.sheet, { backgroundColor: colors.bg }]}
      >
        <View style={styles.modalHeader}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close the note"
            onPress={props.onClose}
            testID={TEST_IDS.notes.editorClose}
            style={styles.iconButton}
          >
            <Icon name="x" size={23} color={colors.text} />
          </Pressable>
          <Text style={[styles.modalTitle, { color: colors.text }]}>
            {note ? (note.trashed ? "In trash" : "Note") : "New note"}
          </Text>
          {note && !note.trashed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={note.pinned ? "Unpin" : "Pin"}
              accessibilityState={{ selected: note.pinned }}
              onPress={props.onTogglePin}
              style={styles.iconButton}
            >
              <Icon
                name="star"
                size={22}
                color={note.pinned ? colors.accent : colors.textFaint}
              />
            </Pressable>
          ) : (
            <View style={styles.iconButton} />
          )}
        </View>

        <ScrollView contentContainerStyle={styles.editor}>
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

        <View style={styles.editorActions}>
          {note?.trashed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Restore this note"
              onPress={props.onRestore}
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
                onPress={props.onSave}
                style={[styles.button, { backgroundColor: colors.accentFill }]}
              >
                <Text style={[styles.buttonText, { color: colors.textInv }]}>
                  Save
                </Text>
              </Pressable>
              {note ? (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Version history"
                    onPress={props.onOpenHistory}
                    style={[styles.button, { borderColor: colors.line }]}
                  >
                    <Icon name="History" size={18} color={colors.textSoft} />
                    <Text
                      style={[styles.buttonText, { color: colors.textSoft }]}
                    >
                      Versions
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Move this note to trash"
                    onPress={props.onTrash}
                    style={[styles.button, { borderColor: colors.danger }]}
                  >
                    <Text style={[styles.buttonText, { color: colors.danger }]}>
                      {DELETE_NOTE_VERB}
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </>
          )}
        </View>

        <NotesPowerbox
          open={linking}
          term={linkTerm}
          excluded={props.journalNoteIds}
          onTerm={setLinkTerm}
          onPick={pick}
          onClose={() => setLinking(false)}
        />
      </TopSafeArea>
    </Modal>
  );
}
