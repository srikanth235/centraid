// Automations (#765, spec §3). No `New automation` — authoring is a
// blueprint act with no mobile route. `Templates` scrolls to `Worth
// setting up` on this page. Trailing slot is `Open`; Pause lives in the
// row expansion.

import React, { useCallback, useMemo, useRef } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";

import { AUTOMATIONS_SUGGESTIONS_NOTE } from "@centraid/client/automations-copy";
import { SKELETON_NOTE } from "@centraid/client/surface-copy";

import Button from "../../kit/components/Button";
import ChipsBlock from "../../kit/components/ChipsBlock";
import EmptyBlock from "../../kit/components/EmptyBlock";
import FeatureOffPlace from "../../kit/components/FeatureOffPlace";
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
import { useReplica } from "../../kit/replica/ReplicaProvider";
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

const LOADING_NOTE = SKELETON_NOTE;

const SUGGESTIONS_NOTE = AUTOMATIONS_SUGGESTIONS_NOTE;

const NO_RUNS_NOTE =
  "Nothing has run yet — run an automation once, or wait for its trigger.";

export default function AutomationsScreen({
  navigation,
  route,
}: AutomationsScreenProps): React.JSX.Element {
  const focusedRef = route.params?.automationRef;
  // Gate above both branches so a switched-off gateway never mounts those hooks.
  const { features } = useReplica();
  if (features && !features.automations)
    return (
      <FeatureOffPlace
        feature="automations"
        onLeave={() => navigation.goBack()}
        title="Automations"
      />
    );
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
      // `push`, not `navigate`: leaving the thread must return here, not Home.
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
            {/* No filled commit. Templates withheld while loading/error. */}
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
      {/* Standing chrome — not inside ScrollView. */}
      <HealthLine
        text={health.text}
        {...(health.action && worst
          ? { action: health.action, onAction: () => open(worst.ref) }
          : {})}
      />
    </TopSafeArea>
  );
}
