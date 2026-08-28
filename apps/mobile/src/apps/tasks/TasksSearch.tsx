// Search, and WHO ANSWERS IT (Tasks spec §1).
//
// The matching happens in the vault's FTS5 index, so this surface dispatches
// the app's own `search` query rather than grepping the replica — a second
// matcher on this device would rank differently from every other seat. That
// makes it a GATEWAY read: with the desktop out of reach there is no answer,
// and the surface says which of the two it is missing instead of drawing an
// empty result set that reads as "nothing matches".

import React, { useEffect, useRef, useState } from "react";
import { FlatList, View } from "react-native";

import type { Task } from "@centraid/blueprints/apps/tasks/types";
import { SEARCH_COPY } from "@centraid/blueprints/apps/tasks/view-copy";

import { Text, TextInput } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import { appQuery } from "../../lib/gateway";
import TaskRow from "./TaskRow";
import {
  SEARCH_IDLE,
  SEARCH_UNREACHABLE_BODY,
  SEARCH_UNREACHABLE_TITLE,
  searchHits,
} from "./tasks-seat-copy";
import type { TasksStyles } from "./TasksHome.styles";

export interface TasksSearchProps {
  now: string;
  styles: TasksStyles;
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
}

export default function TasksSearch({
  now,
  styles,
  onToggle,
  onOpen,
}: TasksSearchProps): React.JSX.Element {
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Task[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  // Monotonic ticket: a slow older answer may never overwrite a newer one.
  const ticket = useRef(0);
  const term = query.trim();

  // Typing clears the previous answer in the HANDLER, never inside the effect.
  const onChangeQuery = (text: string): void => {
    ticket.current += 1;
    setQuery(text);
    setRows(null);
    setUnreachable(false);
  };

  useEffect(() => {
    const mine = (ticket.current += 1);
    if (!term) return;
    void (async () => {
      try {
        const answer = await appQuery<{ tasks?: Task[] }>("tasks", "search", {
          term,
        });
        if (mine !== ticket.current) return;
        setUnreachable(false);
        setRows(answer.tasks ?? []);
      } catch {
        if (mine !== ticket.current) return;
        setRows(null);
        setUnreachable(true);
      }
    })();
  }, [term]);

  return (
    <View style={styles.pane}>
      <TextInput
        accessibilityLabel={SEARCH_COPY.placeholder}
        autoFocus
        placeholder={SEARCH_COPY.placeholder}
        placeholderTextColor={colors.textGhost}
        value={query}
        onChangeText={onChangeQuery}
        style={styles.searchField}
      />
      {term.length === 0 ? (
        <Text style={styles.lead}>{SEARCH_IDLE}</Text>
      ) : null}
      {unreachable ? (
        <View style={styles.card}>
          <Text style={styles.cardHead}>{SEARCH_UNREACHABLE_TITLE}</Text>
          <Text style={styles.cardBody}>{SEARCH_UNREACHABLE_BODY}</Text>
        </View>
      ) : null}
      {rows ? (
        <>
          <Text style={styles.num}>{searchHits(rows.length)}</Text>
          <FlatList
            data={rows}
            keyExtractor={(task) => task.task_id}
            renderItem={({ item }) => (
              <TaskRow
                task={item}
                now={now}
                styles={styles}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            )}
          />
        </>
      ) : null}
    </View>
  );
}
