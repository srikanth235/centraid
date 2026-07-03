import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from '../components/Icon';
import Button from '../components/Button';
import { colors, family, radii, spacing, t } from '../theme';
import {
  confirmParked,
  GatewayError,
  listParked,
  resolveGatewayBase,
  type ParkedInvocation,
} from '../lib/gateway';
import type { RootScreenProps } from '../navigation';

// Parked vault invocations awaiting the owner's say-so — medium+ acts that
// apps/agents submitted get parked by the vault's consent gateway. This
// screen lists them over the current gateway base (tunnel or manual) and
// lets the owner approve or deny each one.

type ApprovalsState =
  | { kind: 'loading' }
  | { kind: 'no-gateway' }
  | { kind: 'ready'; rows: ParkedInvocation[] }
  | { kind: 'error'; message: string };

export default function ApprovalsScreen({
  navigation,
}: RootScreenProps<'Approvals'>): React.JSX.Element {
  const [state, setState] = useState<ApprovalsState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      const base = await resolveGatewayBase();
      if (!base) {
        setState({ kind: 'no-gateway' });
        return;
      }
      const rows = await listParked();
      setState({ kind: 'ready', rows });
    } catch (err) {
      const message =
        err instanceof GatewayError || err instanceof Error
          ? err.message
          : 'Could not load approvals.';
      setState({ kind: 'error', message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setActionError(undefined);
    await load();
    setRefreshing(false);
  }, [load]);

  const decide = useCallback(async (invocationId: string, approve: boolean): Promise<void> => {
    setActionError(undefined);
    try {
      await confirmParked(invocationId, approve);
      setState((prev) =>
        prev.kind === 'ready'
          ? { kind: 'ready', rows: prev.rows.filter((r) => r.invocationId !== invocationId) }
          : prev,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not record the decision.');
    }
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.bar}>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={12}
          accessibilityLabel="Back"
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
        >
          <Icon name="ArrowLeft" size={20} color={colors.ink} strokeWidth={1.75} />
        </Pressable>
        <Text style={styles.title}>Approvals</Text>
        <View style={styles.barSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.ink3}
          />
        }
      >
        {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}
        {renderBody(state, decide, () => navigation.navigate('Settings'))}
      </ScrollView>
    </SafeAreaView>
  );
}

function renderBody(
  state: ApprovalsState,
  decide: (invocationId: string, approve: boolean) => Promise<void>,
  openSettings: () => void,
): React.JSX.Element {
  if (state.kind === 'loading') {
    return <Text style={styles.emptyCopy}>Loading…</Text>;
  }
  if (state.kind === 'no-gateway') {
    return (
      <View>
        <Text style={styles.emptyTitle}>Not connected.</Text>
        <Text style={styles.emptyCopy}>Pair with your desktop to review pending approvals.</Text>
        <View style={styles.emptyAction}>
          <Button label="Open Settings" icon="Settings" variant="soft" onPress={openSettings} />
        </View>
      </View>
    );
  }
  if (state.kind === 'error') {
    return (
      <View>
        <Text style={styles.emptyTitle}>Could not load approvals.</Text>
        <Text style={styles.emptyCopy}>{state.message}</Text>
        <Text style={styles.emptyHint}>Pull to refresh to retry.</Text>
      </View>
    );
  }
  if (state.rows.length === 0) {
    return <Text style={styles.emptyCopy}>Nothing waiting for approval.</Text>;
  }
  return (
    <View style={styles.list}>
      {state.rows.map((row) => (
        <ParkedCard key={row.invocationId} row={row} decide={decide} />
      ))}
    </View>
  );
}

function ParkedCard({
  row,
  decide,
}: {
  row: ParkedInvocation;
  decide: (invocationId: string, approve: boolean) => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const choose = (approve: boolean): void => {
    setBusy(true);
    void decide(row.invocationId, approve).finally(() => setBusy(false));
  };
  return (
    <View style={styles.card}>
      <Text style={styles.cardCommand}>{row.command}</Text>
      <Text style={styles.cardCaller}>
        {row.caller ?? row.callerKind} · {formatWhen(row.parkedAt)}
      </Text>
      <Text style={styles.cardPayload} numberOfLines={3}>
        {summarizeInput(row.input)}
      </Text>
      <View style={styles.cardActions}>
        <Button
          label="Approve"
          icon="Check"
          onPress={() => choose(true)}
          disabled={busy}
          style={styles.cardBtn}
        />
        <Button
          label="Deny"
          icon="X"
          variant="soft"
          onPress={() => choose(false)}
          disabled={busy}
          style={styles.cardBtn}
        />
      </View>
    </View>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function summarizeInput(input: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(input);
    if (!json || json === '{}') return 'No payload.';
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return 'Payload unavailable.';
  }
}

const styles = StyleSheet.create({
  actionError: { ...t('small'), color: colors.danger, marginBottom: spacing[3] },
  backBtn: {
    alignItems: 'center',
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  bar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: spacing[2],
  },
  barSpacer: { width: 36 },
  body: { padding: spacing[5] },
  card: {
    backgroundColor: colors.bgElev,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1,
    padding: spacing[4],
  },
  cardActions: { flexDirection: 'row', gap: spacing[3], marginTop: spacing[3] },
  cardBtn: { flex: 1 },
  cardCaller: { ...t('small'), color: colors.ink3, marginTop: 2 },
  cardCommand: { ...t('bodyStrong'), color: colors.ink },
  cardPayload: {
    ...t('small'),
    color: colors.ink2,
    fontFamily: family.monoRegular,
    marginTop: spacing[2],
  },
  emptyAction: { alignSelf: 'stretch', marginTop: spacing[4] },
  emptyCopy: { ...t('body'), color: colors.ink2 },
  emptyHint: { ...t('small'), color: colors.ink3, marginTop: spacing[2] },
  emptyTitle: { ...t('title'), color: colors.ink, marginBottom: spacing[2] },
  list: { gap: spacing[3] },
  safe: { backgroundColor: colors.bg, flex: 1 },
  title: { ...t('title'), color: colors.ink },
});
