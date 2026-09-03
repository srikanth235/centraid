// The Search shelf (handoff Part 2 §5; #821) — field first, then the
// same rows as the drive.
//
// WHAT THIS SEARCH REACHES, honestly: the phone's replica indexes document
// TITLES (packages/client — the core.document local-search shape), so this
// field promises titles and nothing more (`MOBILE_SEARCH_PLACEHOLDER`; the
// web's "Search titles and contents" constant explicitly says mobile "owes a
// different sentence"). The state the handoff says no other app needs — what
// the search could NOT read — is therefore the WHOLE drive here: every result
// was matched on title and filing only, and the caption says so with the
// spec's own sentence, count interpolated (`captionFor`'s searchUnreadable).
//
// States: idle · results · no results · refused (the replica cannot search
// this entity) — plus offline, which for a LOCAL index is not a refusal:
// the replica answers from this device, and the standing offline caption on
// the drive shelves already carries that fact.
import { useNavigation } from "@react-navigation/native";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { SEARCH_CLEAR } from "@centraid/blueprints/apps/docs/drive-copy";
import { SEARCH } from "@centraid/blueprints/apps/docs/shelves";
import { captionFor } from "@centraid/blueprints/apps/docs/view-copy";

import { Text, TextInput } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsShellNavigation } from "../../navigation";
import {
  MOBILE_SEARCH_LABEL,
  MOBILE_SEARCH_PLACEHOLDER,
  SEARCH_IDLE,
  SEARCH_REACH_ACTION,
  SEARCH_REACH_BODY,
  SEARCH_REACH_EYEBROW,
  searchReachTitle,
  searchStatus,
} from "./docs-copy";
import DriveList from "./DriveList";
import type { UseDocsResult } from "./useDocs";

export default function DocsSearchView({
  drive,
}: {
  drive: UseDocsResult;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { session } = useReplica();
  const navigation = useNavigation<DocsShellNavigation>();
  const [query, setQuery] = useState("");
  const [matchedIds, setMatchedIds] = useState<readonly string[] | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Monotonic ticket: a slow older search may never overwrite a newer answer.
  const ticket = useRef(0);

  const term = query.trim();
  // Typing resets the answer in the HANDLER (never synchronously inside the
  // effect — react-compiler's EffectSetState rule); the effect only runs the
  // async search and lands its result.
  const onChangeQuery = (text: string): void => {
    ticket.current += 1;
    setQuery(text);
    setMatchedIds(null);
    setRefusal(null);
  };
  useEffect(() => {
    const mine = (ticket.current += 1);
    if (!term || !session) return;
    void (async () => {
      try {
        const result = await session.search("docs", {
          entity: "core.document",
          query: term,
        });
        if (mine !== ticket.current) return;
        setRefusal(null);
        setMatchedIds(
          result.rows.flatMap((row) => {
            const id = row.values["document_id"];
            return typeof id === "string" ? [id] : [];
          })
        );
      } catch (error) {
        if (mine !== ticket.current) return;
        // The replica refused the search itself — a different sentence from
        // "nothing matches", so it is never collapsed into the miss state.
        setMatchedIds(null);
        setRefusal(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [term, session]);

  const active = useMemo(
    () => drive.documents.filter((doc) => !doc.trashed),
    [drive.documents]
  );
  // Trashed documents never match (the manifest's own search rule).
  const results = useMemo(() => {
    if (!matchedIds) return [];
    const order = new Map(matchedIds.map((id, index) => [id, index]));
    return active
      .filter((doc) => order.has(doc.document_id))
      .sort(
        (a, b) =>
          (order.get(a.document_id) ?? 0) - (order.get(b.document_id) ?? 0)
      );
  }, [active, matchedIds]);

  const searching = term.length > 0 && matchedIds !== null && !refusal;

  return (
    <View style={styles.page}>
      <View style={styles.fieldRow}>
        <TextInput
          accessibilityLabel={MOBILE_SEARCH_LABEL}
          autoFocus
          placeholder={MOBILE_SEARCH_PLACEHOLDER}
          placeholderTextColor={colors.textFaint}
          value={query}
          onChangeText={onChangeQuery}
          style={styles.field}
        />
        {query.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={SEARCH_CLEAR}
            onPress={() => onChangeQuery("")}
            style={styles.clear}
          >
            <Text style={styles.clearLabel}>{SEARCH_CLEAR}</Text>
          </Pressable>
        ) : null}
      </View>

      {term.length === 0 ? (
        <View style={styles.reach}>
          <Text style={styles.reachEyebrow}>{SEARCH_REACH_EYEBROW}</Text>
          <Text accessibilityRole="header" style={styles.reachTitle}>
            {searchReachTitle(active.length)}
          </Text>
          <Text style={styles.reachBody}>{SEARCH_REACH_BODY}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={SEARCH_REACH_ACTION}
            onPress={() => navigation.navigate("DocsCapabilities")}
            style={styles.reachAction}
          >
            <Text style={styles.reachActionLabel}>{SEARCH_REACH_ACTION}</Text>
          </Pressable>
          <Text style={styles.idle}>{SEARCH_IDLE}</Text>
        </View>
      ) : refusal ? (
        <View style={styles.refusal}>
          <Text style={styles.refusalTitle}>
            Search is unavailable on this device
          </Text>
          <Text style={styles.refusalBody}>{refusal}</Text>
        </View>
      ) : searching ? (
        <DriveList
          shelf={SEARCH}
          docs={results}
          folders={drive.folders}
          loading={drive.loading}
          connection={drive.connection}
          {...(drive.error ? { error: drive.error } : {})}
          offline={drive.offline}
          refresh={drive.refresh}
          empty={{ query: term }}
          // Said on BOTH answers, not just the hit. A miss is exactly when the
          // member needs to know the search never looked inside anything —
          // withholding it there leaves "nothing matches" reading as "it is
          // not in your vault".
          caption={captionFor(SEARCH, { searchUnreadable: active.length })}
          status={
            results.length > 0
              ? searchStatus(results.length, active.length)
              : null
          }
        />
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    clear: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: 8,
    },
    clearLabel: {
      ...t("control"),
      color: colors.text,
      textDecorationLine: "underline",
    },
    field: {
      ...t("body"),
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      flex: 1,
      minHeight: 44,
      paddingHorizontal: 12,
    },
    fieldRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      paddingBottom: 8,
      paddingHorizontal: 18,
    },
    idle: {
      ...t("body"),
      color: colors.textSoft,
      paddingTop: 4,
    },
    page: { flex: 1 },
    reach: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: 8,
      marginHorizontal: 18,
      padding: 16,
    },
    reachAction: {
      alignSelf: "flex-start",
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      justifyContent: "center",
      marginTop: 4,
      minHeight: 44,
      paddingHorizontal: 18,
    },
    reachActionLabel: { ...t("control"), color: colors.text },
    reachBody: { ...t("small"), color: colors.textSoft },
    reachEyebrow: { ...t("eyebrow"), color: colors.textFaint },
    reachTitle: { ...t("bodyStrong"), color: colors.text },
    refusal: {
      borderColor: colors.net,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: 6,
      marginHorizontal: 18,
      padding: 16,
    },
    refusalBody: { ...t("small"), color: colors.textSoft },
    refusalTitle: { ...t("bodyStrong"), color: colors.text },
  });
