import { useCallback, useEffect, useState } from "react";

import { GatewayError, resolveGatewayBase } from "../../lib/gateway";
import {
  fetchGatewayHealth,
  fetchInsightsSummary,
  type GatewayHealth,
  type InsightsSummary,
} from "../../lib/insights";
import { subscribeSpaces } from "../../lib/spaces";

// The Insights screen mirrors TWO independent gateway surfaces — health
// (gateway-wide) and usage (vault-scoped) — that can be available on different
// gateway versions. So `ready` carries each optionally, each with its own error
// string, and neither one failing collapses the whole screen: a gateway that
// serves health but not `/_insights` (or vice versa) still shows what it has.
// A `no-gateway` degrade stays a first-class calm state, distinct from a
// transport error, matching useAutomations.
export type InsightsState =
  | { kind: "loading" }
  | { kind: "no-gateway" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      health?: GatewayHealth;
      summary?: InsightsSummary;
      healthError?: string;
      summaryError?: string;
    };

export interface UseInsights {
  state: InsightsState;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

const WINDOW_DAYS = 30;

function messageOf(reason: unknown): string {
  return reason instanceof GatewayError || reason instanceof Error
    ? reason.message
    : "Unavailable on this gateway.";
}

// The loader lives outside the hook: it closes over nothing but the (stable)
// state setter, so it needs no `useCallback` identity dance, it is testable on
// its own, and the effects below are plainly async kick-offs rather than
// something that could set state during the effect body.
async function loadInsights(
  setState: (next: InsightsState) => void
): Promise<void> {
  const base = await resolveGatewayBase().catch(() => undefined);
  if (!base) {
    setState({ kind: "no-gateway" });
    return;
  }
  // Load both in parallel; a failure of one must not sink the other.
  const [healthRes, summaryRes] = await Promise.allSettled([
    fetchGatewayHealth(),
    fetchInsightsSummary(WINDOW_DAYS),
  ]);
  const health = healthRes.status === "fulfilled" ? healthRes.value : undefined;
  const summary =
    summaryRes.status === "fulfilled" ? summaryRes.value : undefined;
  // Both failing is a real error (the gateway is reachable but answering
  // nothing useful) — surface it rather than an empty page.
  if (!health && !summary) {
    setState({
      kind: "error",
      message: messageOf((healthRes as PromiseRejectedResult).reason),
    });
    return;
  }
  setState({
    kind: "ready",
    health,
    summary,
    healthError:
      healthRes.status === "rejected" ? messageOf(healthRes.reason) : undefined,
    summaryError:
      summaryRes.status === "rejected"
        ? messageOf(summaryRes.reason)
        : undefined,
  });
}

export function useInsights(): UseInsights {
  const [state, setState] = useState<InsightsState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void loadInsights(setState);
  }, []);
  // Switching the active Space re-points usage at a different vault — reload.
  useEffect(() => subscribeSpaces(() => void loadInsights(setState)), []);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await loadInsights(setState);
    setRefreshing(false);
  }, []);

  return { state, refreshing, refresh };
}
