// AUTOMATIONS — what this vault does on its own (#765, spec §3).
//
// The page is a SEQUENCE OF BLOCKS and nothing else: a section head, a row
// list, a run feed, the suggestions, a note. What the tile-shaped cards used
// to carry, and where each part went:
//
//   the On/Off pill      → the row's state word (`Active` / `Paused`), plus
//                          the one quiet verb in the row's expansion, so the
//                          write survives; the pill's colour does not, because
//                          a fill is not a state word.
//   the schedule line    → the row's sub line, first clause.
//   the description      → gone from the list. The row's second line is what
//                          fires it and how it last went (spec §3); the
//                          automation's own prose belongs where it is opened.
//   `Run now` per card   → the automation's thread, which already carries it,
//                          and which `Open` now reaches.
//   the starter gallery  → the `Worth setting up` section, with the note that
//                          says where those suggestions really come from.
//
// TWO DELIBERATE WITHHOLDINGS.
//  - `New automation` (the reference's filled commit) is ABSENT. Authoring an
//    automation means writing a manifest — a blueprint act with no mobile
//    surface and no route on `lib/automations.ts` to reach. A filled verb that
//    opened nothing would be the one thing this page cannot afford. When
//    mobile grows an author flow, the verb lands here and nowhere else.
//  - `Templates` is the quiet verb, and it is honest about what it is: on this
//    surface the template catalogue IS the `Worth setting up` list further
//    down the same page, so the verb takes you there rather than opening a
//    second screen that would hold the same six rows. It is withheld entirely
//    when the catalogue came back empty.
//
// THE ROW'S ONE TRAILING SLOT is spoken for by `Open` (spec §3). Pausing a
// live automation is a capability this phone already had, so it keeps a
// control: one quiet verb in the row's own expansion (`RowsBlock`'s documented
// escape hatch), under the line it belongs to. A paused row needs no
// expansion — its trailing verb is already `Resume`, which is the reference's
// own verb for that row.

import React, { useCallback, useMemo, useRef } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";

import Button from "../../kit/components/Button";
import ChipsBlock from "../../kit/components/ChipsBlock";
import EmptyBlock from "../../kit/components/EmptyBlock";
import { healthLineFor } from "../../kit/components/health-line";
import HealthLine from "../../kit/components/HealthLine";
import HomeKey from "../../kit/components/HomeKey";
import { Text } from "../../kit/components/NativeText";
import NoteBlock from "../../kit/components/NoteBlock";
import PanelBlock from "../../kit/components/PanelBlock";
import PlaceHeader from "../../kit/components/PlaceHeader";
import RowsBlock from "../../kit/components/RowsBlock";
import type { RowsBlockRow } from "../../kit/components/RowsBlock";
import SectionBlock from "../../kit/components/SectionBlock";
import SkeletonRows from "../../kit/components/SkeletonRows";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useTheme } from "../../kit/theme";
import type { AutomationsScreenProps } from "../../navigation";
import {
  automationRowCopy,
  automationsHealth,
  countSentence,
  EMPTY_ACTION,
  EMPTY_BODY,
  EMPTY_TITLE,
  ERROR_RETRY,
  ERROR_TITLE,
  errorBody,
  filterChips,
  matchesFilter,
  runRowCopy,
  showingSentence,
  suggestionRowCopy,
  worstFailure,
} from "./automations-model";
import type { AutomationRowCopy } from "./automations-model";
import { styles } from "./Automations.styles";
import AutomationThread from "./AutomationThread";
import { RECENT_CAP, useAutomations } from "./useAutomations";
import type { AutomationsController } from "./useAutomations";

/** Why a skeleton, said once, under the skeleton (spec §10). */
const LOADING_NOTE =
  "A row knows its shape before its content arrives, so nothing reflows when it does.";

/**
 * The suggestions note.
 *
 * The reference's sentence is "Suggestions come from what you already do by
 * hand." That is not true of this product: the list is a curated slice of the
 * TEMPLATE CATALOGUE (`listAutomationTemplates`), keyed off a fixed id list —
 * nothing watches what a member does by hand and nothing infers a rule from
 * it. The second half of the sentence is true and load-bearing, so it stands
 * verbatim; the provenance half states the provenance this product has. Same
 * words as the desktop screen, so both surfaces make one promise.
 */
const SUGGESTIONS_NOTE =
  "Suggestions come from the template catalogue, not from watching you. They are never created for you.";

/** What the run feed says when the vault has automations but no history. */
const NO_RUNS_NOTE =
  "Nothing has run yet. Open an automation and run it once, or wait for its trigger.";

export default function AutomationsScreen({
  navigation,
  route,
}: AutomationsScreenProps): React.JSX.Element {
  const focusedRef = route.params?.automationRef;
  return focusedRef ? (
    <AutomationThread
      automationRef={focusedRef}
      onLeave={() => navigation.goBack()}
    />
  ) : (
    <AutomationsPlace navigation={navigation} route={route} />
  );
}

interface BodyProps {
  page: AutomationsController;
  copies: readonly AutomationRowCopy[];
  onOpen: (ref: string) => void;
  onBrowseTemplates: () => void;
  onSuggestionsLayout: (event: LayoutChangeEvent) => void;
}

function AutomationsBody({
  page,
  copies,
  onOpen,
  onBrowseTemplates,
  onSuggestionsLayout,
}: BodyProps): React.JSX.Element {
  const { state } = page;

  if (state === "loading")
    return (
      <>
        <SkeletonRows accessibilityLabel="Reading your automations" />
        <NoteBlock text={LOADING_NOTE} />
      </>
    );

  if (state === "error")
    return (
      <PanelBlock
        body={
          page.load.kind === "error" && page.load.unpaired
            ? page.load.reason
            : errorBody(page.lastRunClock)
        }
        eyebrow="Automations"
        facts={
          page.load.kind === "error" && !page.load.unpaired
            ? [
                {
                  key: "what happened",
                  net: true,
                  value: page.load.reason,
                },
              ]
            : undefined
        }
        action={{ label: ERROR_RETRY, onPress: page.retry }}
        title={ERROR_TITLE}
        tone="net"
      />
    );

  const suggestions = (
    <View onLayout={onSuggestionsLayout}>
      {page.templates.length > 0 ? (
        <>
          <SectionBlock
            label="Worth setting up"
            meta={String(page.templates.length)}
          />
          <RowsBlock
            accessibilityLabel="Worth setting up"
            rows={page.templates.map((template) => {
              const copy = suggestionRowCopy(template, page.installing);
              return {
                action: {
                  hint: `${copy.action} ${copy.title}`,
                  label: copy.action,
                  onPress: () => page.install(template),
                },
                key: copy.key,
                sub: copy.sub,
                title: copy.title,
              };
            })}
          />
          <NoteBlock text={SUGGESTIONS_NOTE} />
        </>
      ) : null}
    </View>
  );

  if (state === "empty")
    return (
      <>
        <EmptyBlock
          {...(page.templates.length > 0
            ? { action: { label: EMPTY_ACTION, onPress: onBrowseTemplates } }
            : {})}
          body={EMPTY_BODY}
          routine
          title={EMPTY_TITLE}
        />
        {suggestions}
      </>
    );

  const full = state === "full";
  const shown = full
    ? copies.filter((copy) => matchesFilter(copy.status, page.filter))
    : copies;
  const automationRows: RowsBlockRow[] = shown.map((copy) => ({
    action: {
      hint: `${copy.action} ${copy.title}`,
      label: copy.action,
      onPress: () =>
        copy.act === "resume"
          ? page.setEnabled(copy.ref, true)
          : onOpen(copy.ref),
    },
    key: copy.key,
    meta: copy.meta,
    net: copy.net,
    sub: copy.sub,
    title: copy.title,
    // The pause write, kept where the trailing slot could not hold it.
    ...(copy.act === "open"
      ? {
          children: (
            <View style={styles.pause}>
              <Button
                label="Pause"
                onPress={() => page.setEnabled(copy.ref, false)}
                variant="secondary"
              />
            </View>
          ),
        }
      : {}),
  }));
  const runs = page.runs.slice(0, RECENT_CAP);

  return (
    <>
      {full ? (
        <ChipsBlock
          accessibilityLabel="Filter automations"
          chips={filterChips(page.filter).map((chip) => ({
            id: chip.key,
            label: chip.label,
            on: chip.on,
            onPress: () => page.setFilter(chip.key),
          }))}
        />
      ) : null}
      <SectionBlock
        label="Automations"
        meta={
          shown.length === copies.length
            ? countSentence(copies)
            : showingSentence(shown.length, copies.length)
        }
      />
      {automationRows.length > 0 ? (
        <RowsBlock accessibilityLabel="Automations" rows={automationRows} />
      ) : (
        <NoteBlock text="No automation is in that state right now." />
      )}

      <SectionBlock
        label="Recent runs across everything"
        meta={String(runs.length)}
      />
      {runs.length > 0 ? (
        <RowsBlock
          accessibilityLabel="Recent runs"
          rows={runs.map((run) => {
            const copy = runRowCopy(run, page.now);
            return {
              action: {
                hint: `View ${copy.title}`,
                label: "View",
                onPress: () => onOpen(copy.ref),
              },
              key: copy.key,
              meta: copy.meta,
              net: copy.net,
              sub: copy.sub,
              title: copy.title,
            };
          })}
        />
      ) : (
        <NoteBlock text={NO_RUNS_NOTE} />
      )}
      {suggestions}
    </>
  );
}

function AutomationsPlace({
  navigation,
}: AutomationsScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const page = useAutomations();
  const scroll = useRef<ScrollView>(null);
  // Where the suggestions section starts, so the quiet verb can take the
  // member to the catalogue that is already on this page.
  const suggestionsY = useRef(0);
  const ink = useMemo(
    () => ({
      error: { color: colors.net },
      safe: { backgroundColor: colors.bg },
    }),
    [colors]
  );

  const open = useCallback(
    (ref: string): void => {
      // `push`, not `navigate`: the thread is a card ON TOP of the list, so
      // leaving it returns here rather than to Home.
      navigation.push("Automations", { automationRef: ref });
    },
    [navigation]
  );

  const browseTemplates = useCallback((): void => {
    const view = scroll.current;
    if (view) view.scrollTo({ animated: true, y: suggestionsY.current });
  }, []);

  const onSuggestionsLayout = useCallback((event: LayoutChangeEvent): void => {
    suggestionsY.current = event.nativeEvent.layout.y;
  }, []);

  const copies = useMemo(
    () =>
      page.rows.map((row) =>
        automationRowCopy(row, {
          known: page.known,
          now: page.now,
          runs: page.runs,
        })
      ),
    [page.rows, page.known, page.now, page.runs]
  );
  const health = healthLineFor(
    page.state,
    automationsHealth(copies, page.runs, page.now)
  );
  const worst = worstFailure(copies);

  return (
    <TopSafeArea edges={["top"]} style={[styles.safe, ink.safe]}>
      <View style={styles.page}>
        <View style={styles.head}>
          <HomeKey onPress={() => navigation.goBack()} variant="leave" />
          <View style={styles.headBar}>
            {/* No filled commit — see the file header. The quiet verb follows
                the reference's gating (hidden while loading), and is withheld
                on error too, where the section it scrolls to is not drawn. */}
            <PlaceHeader
              title="Automations"
              {...(page.templates.length > 0 &&
              page.state !== "loading" &&
              page.state !== "error"
                ? {
                    secondary: { label: "Templates", onPress: browseTemplates },
                  }
                : {})}
            />
          </View>
        </View>
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          ref={scroll}
          refreshControl={
            <RefreshControl
              onRefresh={() => void page.refresh()}
              refreshing={page.refreshing}
              tintColor={colors.textFaint}
            />
          }
          style={styles.scroll}
        >
          {page.actionError ? (
            <Text style={[styles.actionError, ink.error]}>
              {page.actionError}
            </Text>
          ) : null}
          <AutomationsBody
            copies={copies}
            onBrowseTemplates={browseTemplates}
            onOpen={open}
            onSuggestionsLayout={onSuggestionsLayout}
            page={page}
          />
        </ScrollView>
      </View>
      {/* Docked above the bottom edge: the line is standing chrome, not
          content, so it does not scroll with the blocks. */}
      <HealthLine
        text={health.text}
        {...(health.action && worst
          ? { action: health.action, onAction: () => open(worst.ref) }
          : {})}
      />
    </TopSafeArea>
  );
}
