// governance: allow-repo-hygiene file-size-limit cohesive Insights cover (gateway health + vault summary cards + refresh); decompose the cards in a follow-up (#498)
// Insights — a mobile-scaled read of two gateway surfaces the desktop keeps on
// its sidebar but the phone launcher otherwise omits: GATEWAY health/metrics
// (the distinctive "what is my gateway doing right now") and a LIMITED slice of
// usage insights (tokens/cost KPIs + a daily sparkline + recent activity), for
// the active vault. A cover in the springboard idiom: teal leave key to dismiss, serif
// title, floating Home key. Both surfaces load independently (useInsights), so a
// gateway serving one but not the other still shows what it has.

import React, { useMemo } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { palette } from '@centraid/design-tokens';

import { useTheme, type ThemeColors } from '../../kit/theme';
import HomeKey from '../../kit/components/HomeKey';
import {
  formatBytes,
  formatCount,
  formatMs,
  formatUptime,
  formatUsd,
  relativeTime,
  type ComponentHealth,
  type ComponentStatus,
  type GatewayHealth,
  type InsightsSummary,
} from '../../lib/insights';
import type { InsightsScreenProps } from '../../navigation';
import { makeStyles } from './Insights.styles';
import { useInsights, type InsightsState } from './useInsights';

type Styles = ReturnType<typeof makeStyles>;
type Colors = ThemeColors;

// Semantic status scale, deliberately separate from the teal accent: a healthy
// green, an amber degrade, the theme's own red for error.
function statusColor(status: ComponentStatus, colors: Colors): string {
  return status === 'ok' ? palette.forest : status === 'degraded' ? palette.amber : colors.danger;
}

const STATUS_WORD: Record<ComponentStatus, string> = {
  ok: 'All systems healthy',
  degraded: 'Running degraded',
  error: 'Needs attention',
};

export default function InsightsScreen({ navigation }: InsightsScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { state, refreshing, refresh } = useInsights();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Insights</Text>
        <Text style={styles.subtitle}>Your gateway and space, at a glance</Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 84 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={colors.ink3}
          />
        }
      >
        <Body state={state} styles={styles} colors={colors} />
      </ScrollView>

      <HomeKey variant="floating" onPress={() => navigation.goBack()} />
    </SafeAreaView>
  );
}

function Body({
  state,
  styles,
  colors,
}: {
  state: InsightsState;
  styles: Styles;
  colors: Colors;
}): React.JSX.Element {
  if (state.kind === 'loading') {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyCopy}>Gathering insights…</Text>
      </View>
    );
  }
  if (state.kind === 'no-gateway') {
    return (
      <View style={styles.emptyWrap}>
        <Feather name="bar-chart-2" size={30} color={colors.accent} />
        <Text style={styles.emptyTitle}>Not connected</Text>
        <Text style={styles.emptyCopy}>
          Connect your desktop to see your gateway health and usage here.
        </Text>
      </View>
    );
  }
  if (state.kind === 'error') {
    return (
      <View style={styles.emptyWrap}>
        <Feather name="alert-circle" size={30} color={colors.accent} />
        <Text style={styles.emptyTitle}>Could not load insights</Text>
        <Text style={styles.emptyCopy}>{state.message}</Text>
        <Text style={styles.emptyHint}>Pull to refresh to retry.</Text>
      </View>
    );
  }

  return (
    <>
      <Text style={styles.sectionLabel}>GATEWAY</Text>
      {state.health ? (
        <HealthHero health={state.health} styles={styles} colors={colors} />
      ) : (
        <Text style={styles.note}>{state.healthError ?? 'Gateway health is unavailable.'}</Text>
      )}

      <Text style={styles.sectionLabel}>USAGE · LAST 30 DAYS</Text>
      {state.summary ? (
        <UsageSection summary={state.summary} styles={styles} colors={colors} />
      ) : (
        <Text style={styles.note}>{state.summaryError ?? 'Usage insights are unavailable.'}</Text>
      )}
    </>
  );
}

// --- Gateway health ---

function HealthHero({
  health,
  styles,
  colors,
}: {
  health: GatewayHealth;
  styles: Styles;
  colors: Colors;
}): React.JSX.Element {
  const tone = statusColor(health.status, colors);
  const { metrics } = health;
  const p99 = metrics.eventLoopLagP99Ms;
  const errored = health.components.filter((c) => c.status !== 'ok');
  const okCount = health.components.length - errored.length;

  return (
    <View style={styles.hero}>
      <View style={styles.heroTop}>
        <View style={[styles.heroDot, { backgroundColor: tone }]} />
        <View style={styles.heroMeta}>
          <Text style={styles.heroStatus}>{STATUS_WORD[health.status]}</Text>
          <Text style={styles.heroSub}>
            {`${okCount}/${health.components.length} components ok · up ${formatUptime(
              health.uptimeMs,
            )}`}
          </Text>
        </View>
      </View>

      <View style={styles.chips}>
        <Chip label="MEMORY" value={formatBytes(metrics.rssBytes)} styles={styles} />
        <Chip label="OUTBOX" value={formatCount(metrics.outboxPending)} styles={styles} />
        {p99 !== undefined ? <Chip label="LOOP p99" value={formatMs(p99)} styles={styles} /> : null}
        {metrics.storageFsyncMs !== undefined ? (
          <Chip label="FSYNC" value={formatMs(metrics.storageFsyncMs)} styles={styles} />
        ) : null}
        {metrics.sseClients !== undefined ? (
          <Chip label="STREAMS" value={formatCount(metrics.sseClients)} styles={styles} />
        ) : null}
      </View>

      <View style={styles.components}>
        {health.components.map((c, i) => (
          <ComponentRow
            key={c.component}
            comp={c}
            first={i === 0}
            styles={styles}
            colors={colors}
          />
        ))}
      </View>

      {health.recentEvents.length > 0 ? (
        <>
          <View style={[styles.divider, { marginTop: 12 }]} />
          {health.recentEvents.slice(0, 3).map((e, i) => (
            <View key={`${e.at}-${i}`} style={styles.eventRow}>
              <View
                style={[
                  styles.eventBadge,
                  { backgroundColor: e.level === 'error' ? colors.danger : palette.amber },
                ]}
              />
              <View style={styles.eventBody}>
                <Text style={styles.eventMsg} numberOfLines={2}>
                  {e.message}
                </Text>
                <Text style={styles.eventMeta}>{`${e.component} · ${relativeTime(e.at)}`}</Text>
              </View>
            </View>
          ))}
        </>
      ) : null}
    </View>
  );
}

function Chip({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: Styles;
}): React.JSX.Element {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipLabel}>{label}</Text>
      <Text style={styles.chipValue}>{value}</Text>
    </View>
  );
}

function ComponentRow({
  comp,
  first,
  styles,
  colors,
}: {
  comp: ComponentHealth;
  first: boolean;
  styles: Styles;
  colors: Colors;
}): React.JSX.Element {
  return (
    <View>
      {first ? null : <View style={styles.divider} />}
      <View style={styles.compRow}>
        <View style={[styles.compDot, { backgroundColor: statusColor(comp.status, colors) }]} />
        <Text style={styles.compName} numberOfLines={1}>
          {comp.component}
        </Text>
        {comp.detail ? (
          <Text style={styles.compDetail} numberOfLines={1}>
            {comp.detail}
          </Text>
        ) : null}
      </View>
      {comp.status !== 'ok' && comp.lastError ? (
        <Text style={styles.compError} numberOfLines={2}>
          {comp.lastError}
        </Text>
      ) : null}
    </View>
  );
}

// --- Usage insights (limited) ---

function UsageSection({
  summary,
  styles,
  colors,
}: {
  summary: InsightsSummary;
  styles: Styles;
  colors: Colors;
}): React.JSX.Element {
  const { kpis } = summary;
  const quotaPct =
    kpis.quotaTokens > 0
      ? Math.min(100, Math.round((kpis.totalTokens / kpis.quotaTokens) * 100))
      : 0;
  const series = summary.daily.map((d) => d.tokens);
  const hasDaily = series.length > 0;
  const dailyTotal = series.reduce((s, v) => s + v, 0);
  const avg = hasDaily ? Math.round(dailyTotal / series.length) : 0;
  const peak = hasDaily ? Math.max(...series) : 0;
  const models = summary.byModel.slice(0, 3);
  const modelMax = Math.max(1, ...models.map((m) => m.tokens));

  return (
    <View>
      <View style={styles.kpiGrid}>
        <Kpi
          icon="activity"
          label="TOKENS"
          value={formatCount(kpis.totalTokens)}
          styles={styles}
          colors={colors}
        >
          {kpis.quotaTokens > 0 ? (
            <View style={styles.meter}>
              <View style={styles.meterTrack}>
                <View
                  style={[
                    styles.meterFill,
                    { backgroundColor: colors.accent, width: `${quotaPct}%` },
                  ]}
                />
              </View>
              <Text style={styles.meterFoot}>{`${quotaPct}% of included`}</Text>
            </View>
          ) : (
            <Text style={styles.kpiFoot}>this window</Text>
          )}
        </Kpi>
        <Kpi
          icon="dollar-sign"
          label="SPENT · USD"
          value={formatUsd(kpis.totalCostUsd)}
          styles={styles}
          colors={colors}
        >
          <Text style={styles.kpiFoot}>
            {kpis.unpricedRuns > 0 ? `${kpis.unpricedRuns} unpriced` : 'last 30 days'}
          </Text>
        </Kpi>
        <Kpi
          icon="zap"
          label="GENERATIONS"
          value={String(kpis.generations)}
          styles={styles}
          colors={colors}
        >
          <Text style={styles.kpiFoot}>{`${kpis.retries} retries`}</Text>
        </Kpi>
        <Kpi
          icon="grid"
          label="APPS TOUCHED"
          value={String(kpis.appsTouched)}
          styles={styles}
          colors={colors}
        >
          <Text style={styles.kpiFoot}>{`≈ ${formatUsd(kpis.forecastCostUsd)} forecast`}</Text>
        </Kpi>
      </View>

      <View style={styles.panel}>
        <View style={styles.panelHead}>
          <Text style={styles.panelTitle}>Daily consumption</Text>
          <Text style={styles.panelMeta}>{`${summary.windowDays} DAYS · TOKENS`}</Text>
        </View>
        {hasDaily ? (
          <>
            <View style={styles.chartStats}>
              <View>
                <Text style={styles.chartStatLabel}>DAILY AVG</Text>
                <Text style={styles.chartStatValue}>{formatCount(avg)}</Text>
              </View>
              <View>
                <Text style={styles.chartStatLabel}>PEAK</Text>
                <Text style={styles.chartStatValue}>{formatCount(peak)}</Text>
              </View>
            </View>
            <Sparkline values={series} colors={colors} />
            <View style={styles.chartAxis}>
              <Text style={styles.chartAxisText}>{summary.daily[0]?.date}</Text>
              <Text style={styles.chartAxisText}>
                {summary.daily[summary.daily.length - 1]?.date}
              </Text>
            </View>
          </>
        ) : (
          <Text style={styles.panelEmpty}>No activity in this window yet.</Text>
        )}
      </View>

      {models.length > 0 ? (
        <View style={styles.panel}>
          <View style={styles.panelHead}>
            <Text style={styles.panelTitle}>By model</Text>
            <Text style={styles.panelMeta}>TOP {models.length}</Text>
          </View>
          {models.map((m) => (
            <View key={m.model} style={styles.model}>
              <Text style={styles.modelName} numberOfLines={1}>
                {m.model}
              </Text>
              <View style={styles.meterTrack}>
                <View
                  style={[
                    styles.meterFill,
                    {
                      backgroundColor: colors.accent,
                      width: `${Math.round((m.tokens / modelMax) * 100)}%`,
                    },
                  ]}
                />
              </View>
              <View style={styles.modelFoot}>
                <Text style={styles.modelFootText}>{formatCount(m.tokens)}</Text>
                <Text style={styles.modelFootText}>{formatUsd(m.costUsd)}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {summary.recent.length > 0 ? (
        <View style={styles.panel}>
          <View style={styles.panelHead}>
            <Text style={styles.panelTitle}>Recent activity</Text>
            <Text style={styles.panelMeta}>{`${summary.recent.length} RUNS`}</Text>
          </View>
          {summary.recent.slice(0, 6).map((a, i) => (
            <View key={a.runId}>
              {i === 0 ? null : <View style={styles.divider} />}
              <View style={styles.act}>
                <Text style={styles.actAgo}>{relativeTime(a.startedAt)}</Text>
                <View style={styles.actBody}>
                  <Text style={styles.actLabel} numberOfLines={1}>
                    {a.label}
                  </Text>
                  <Text style={styles.actKind}>
                    {`${a.kind.toUpperCase()}${a.ok ? '' : ' · FAILED'}`}
                  </Text>
                </View>
                <View style={styles.actNums}>
                  <Text style={styles.actTokens}>{formatCount(a.tokens)}</Text>
                  <Text style={styles.actUsd}>{formatUsd(a.costUsd)}</Text>
                </View>
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Kpi({
  icon,
  label,
  value,
  children,
  styles,
  colors,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  value: string;
  children: React.ReactNode;
  styles: Styles;
  colors: Colors;
}): React.JSX.Element {
  return (
    <View style={styles.kpi}>
      <View style={styles.kpiLabel}>
        <Feather name={icon} size={12} color={colors.ink3} />
        <Text style={styles.kpiLabelText}>{label}</Text>
      </View>
      <Text style={styles.kpiValue}>{value}</Text>
      {children}
    </View>
  );
}

// A teal area sparkline — the mobile port of the desktop Insights LineChart:
// same area-gradient + peak marker, sized to the panel. `preserveAspectRatio`
// "none" lets the fixed viewBox stretch to the card width.
function Sparkline({
  values,
  colors,
}: {
  values: readonly number[];
  colors: Colors;
}): React.JSX.Element {
  const W = 320;
  const H = 96;
  const PAD = 10;
  const pts = values.length === 1 ? [values[0] ?? 0, values[0] ?? 0] : values;
  const n = pts.length;
  const max = Math.max(...pts);
  const min = Math.min(...pts);
  const span = max - min || 1;
  const px = (i: number): number => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const py = (v: number): number => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const coords = pts.map((v, i) => [px(i), py(v)] as const);
  const line = coords
    .map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(' ');
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  const peakIdx = pts.indexOf(max);
  const peak = coords[peakIdx] ?? ([0, 0] as const);

  return (
    <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <Defs>
        <LinearGradient id="insArea" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor={colors.accent} stopOpacity={0.28} />
          <Stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={area} fill="url(#insArea)" />
      <Path
        d={line}
        fill="none"
        stroke={colors.accent}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <Circle
        cx={peak[0]}
        cy={peak[1]}
        r={3.5}
        fill={colors.bgElev}
        stroke={colors.accent}
        strokeWidth={2}
      />
    </Svg>
  );
}
