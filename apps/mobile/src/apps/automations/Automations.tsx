import { Feather } from "@expo/vector-icons";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import HomeKey from "../../kit/components/HomeKey";
import { spacing, useTheme } from "../../kit/theme";
import {
  cloneAutomationTemplate,
  listAutomationTemplates,
  runAutomation,
} from "../../lib/automations";
import type { AutomationRow, AutomationTemplate } from "../../lib/automations";
import type { AutomationsScreenProps } from "../../navigation";
import { makeStyles } from "./Automations.styles";
import { useAutomations } from "./useAutomations";
import type { AutomationsState } from "./useAutomations";

export default function AutomationsScreen({
  navigation,
}: AutomationsScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { state, refreshing, refresh, toggle } = useAutomations();
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void listAutomationTemplates()
      .then((rows) => {
        if (mounted) setTemplates(rows);
      })
      .catch(() => {
        if (mounted) setTemplates([]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const install = useCallback(
    (template: AutomationTemplate): void => {
      if (installing) return;
      setInstalling(template.id);
      void cloneAutomationTemplate(template.id)
        .then(async () => {
          await refresh();
          Alert.alert("Automation added", `${template.name} is ready to use.`);
        })
        .catch((error: unknown) => {
          Alert.alert(
            "Could not add automation",
            error instanceof Error ? error.message : "Please try again."
          );
        })
        .finally(() => setInstalling(null));
    },
    [installing, refresh]
  );

  const rows = state.kind === "ready" ? state.rows : [];

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <HomeKey variant="leave" onPress={() => navigation.goBack()} />
        <View style={styles.headerText}>
          <Text style={styles.title}>Automations</Text>
          <Text style={styles.subtitle}>
            Conversations that run on their own
          </Text>
        </View>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row) => row.ref}
        contentContainerStyle={[
          styles.list,
          // The back key now lives in the header, so the list only needs to clear
          // the home-indicator safe area.
          { paddingBottom: insets.bottom + spacing[4] },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={colors.ink3}
          />
        }
        ListEmptyComponent={
          <EmptyState state={state} styles={styles} colors={colors} />
        }
        ListFooterComponent={
          templates.length > 0 && state.kind === "ready" ? (
            <AutomationGallery
              templates={templates}
              installing={installing}
              onInstall={install}
              styles={styles}
              colors={colors}
            />
          ) : null
        }
        renderItem={({ item }) => (
          <AutomationCard
            row={item}
            toggle={toggle}
            styles={styles}
            colors={colors}
          />
        )}
      />
    </SafeAreaView>
  );
}

type Styles = ReturnType<typeof makeStyles>;
type Colors = ReturnType<typeof useTheme>["colors"];

function AutomationGallery({
  templates,
  installing,
  onInstall,
  styles,
  colors,
}: {
  templates: AutomationTemplate[];
  installing: string | null;
  onInstall: (template: AutomationTemplate) => void;
  styles: Styles;
  colors: Colors;
}): React.JSX.Element {
  return (
    <View style={styles.gallery} accessibilityRole="summary">
      <View style={styles.galleryHead}>
        <Text style={styles.galleryTitle}>Starter gallery</Text>
        <Text style={styles.gallerySubtitle}>
          Cross-app workflows you can add to this vault
        </Text>
      </View>
      {templates.map((template) => {
        const busy = installing === template.id;
        return (
          <View key={template.id} style={styles.templateCard}>
            <View style={styles.templateIcon} accessibilityElementsHidden>
              <Feather name="zap" size={16} color={colors.accent} />
            </View>
            <View style={styles.templateCopy}>
              <Text style={styles.templateName}>{template.name}</Text>
              <Text style={styles.templateDesc} numberOfLines={3}>
                {template.desc}
              </Text>
              {template.triggerLabel ? (
                <Text style={styles.templateTrigger}>
                  {template.triggerLabel}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Add ${template.name}`}
              accessibilityState={{ busy, disabled: installing !== null }}
              disabled={installing !== null}
              onPress={() => onInstall(template)}
              style={[styles.addBtn, busy && styles.dim]}
            >
              <Text style={styles.addBtnText}>{busy ? "Adding…" : "Add"}</Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

function EmptyState({
  state,
  styles,
  colors,
}: {
  state: AutomationsState;
  styles: Styles;
  colors: Colors;
}): React.JSX.Element {
  if (state.kind === "loading") {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyCopy}>Opening your automations…</Text>
      </View>
    );
  }
  if (state.kind === "no-gateway") {
    return (
      <View style={styles.emptyWrap}>
        <Feather name="zap-off" size={30} color={colors.accent} />
        <Text style={styles.emptyTitle}>Not connected</Text>
        <Text style={styles.emptyCopy}>
          Connect your desktop to see your automations and run them from here.
        </Text>
      </View>
    );
  }
  if (state.kind === "error") {
    return (
      <View style={styles.emptyWrap}>
        <Feather name="alert-circle" size={30} color={colors.accent} />
        <Text style={styles.emptyTitle}>Could not load automations</Text>
        <Text style={styles.emptyCopy}>{state.message}</Text>
        <Text style={styles.emptyHint}>Pull to refresh to retry.</Text>
      </View>
    );
  }
  // ready + no rows
  return (
    <View style={styles.emptyWrap}>
      <Feather name="zap" size={30} color={colors.accent} />
      <Text style={styles.emptyTitle}>No automations yet</Text>
      <Text style={styles.emptyCopy}>
        An automation is a saved conversation that fires on a trigger. Pick a
        starter below or create one on desktop.
      </Text>
    </View>
  );
}

type RunState = "idle" | "running" | "started";

function AutomationCard({
  row,
  toggle,
  styles,
  colors,
}: {
  row: AutomationRow;
  toggle: (ref: string, next: boolean) => Promise<void>;
  styles: Styles;
  colors: Colors;
}): React.JSX.Element {
  const [run, setRun] = useState<RunState>("idle");
  const [busyToggle, setBusyToggle] = useState(false);
  // A transient "Started" state settles back to "idle" on a timer; the mounted
  // ref keeps that late setState from firing after the card unmounts.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fire = useCallback((): void => {
    if (run === "running") return;
    setRun("running");
    void runAutomation(row.ref)
      .then(() => {
        if (!mounted.current) return;
        setRun("started");
        setTimeout(() => {
          if (mounted.current) setRun("idle");
        }, 2200);
      })
      .catch((error: unknown) => {
        if (mounted.current) setRun("idle");
        Alert.alert(
          "Could not run",
          error instanceof Error ? error.message : "Please try again."
        );
      });
  }, [run, row.ref]);

  const flip = useCallback((): void => {
    if (busyToggle) return;
    setBusyToggle(true);
    void toggle(row.ref, !row.enabled)
      .catch((error: unknown) => {
        Alert.alert(
          "Could not update",
          error instanceof Error ? error.message : "The change was not saved."
        );
      })
      .finally(() => {
        if (mounted.current) setBusyToggle(false);
      });
  }, [busyToggle, toggle, row.ref, row.enabled]);

  const runLabel =
    run === "running" ? "Running…" : run === "started" ? "Started" : "Run now";

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardName} numberOfLines={1}>
          {row.name}
        </Text>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: row.enabled, disabled: busyToggle }}
          accessibilityLabel={`${row.enabled ? "Disable" : "Enable"} ${row.name}`}
          onPress={flip}
          style={[
            styles.togglePill,
            { backgroundColor: row.enabled ? colors.accent : colors.bgSunken },
            busyToggle && styles.dim,
          ]}
        >
          <Text
            style={[
              styles.toggleText,
              { color: row.enabled ? colors.inkInv : colors.ink3 },
            ]}
          >
            {row.enabled ? "On" : "Off"}
          </Text>
        </Pressable>
      </View>

      <View style={styles.scheduleRow}>
        <Feather name="clock" size={12} color={colors.ink3} />
        <Text style={styles.scheduleText}>{row.scheduleLabel}</Text>
      </View>

      {row.description ? (
        <Text style={styles.description} numberOfLines={3}>
          {row.description}
        </Text>
      ) : null}

      <View style={styles.cardActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Run ${row.name} now`}
          onPress={fire}
          disabled={run === "running"}
          style={[
            styles.runBtn,
            { borderColor: colors.lineStrong },
            run !== "idle" && styles.dim,
          ]}
        >
          <Feather
            name={run === "started" ? "check" : "play"}
            size={13}
            color={colors.accent}
          />
          <Text style={styles.runText}>{runLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}
