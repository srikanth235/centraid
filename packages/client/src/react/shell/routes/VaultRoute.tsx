import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import type { AtlasReport } from "../../screens/AtlasScreen.js";
import type { HouseholdReport } from "../../screens/HouseholdScreen.js";
import { sectionsStartCollapsed } from "../../screens/vault-sections.js";
import VaultReachSection from "../../screens/VaultReachSection.js";
import { useShellActions } from "../actions.js";
import type { OpsPage, OpsState } from "../opsBar.js";
import PageScroll from "../PageScroll.js";
import {
  clearRouteSignals,
  publishRouteSignals,
  publishRouteVerbs,
} from "../routeVitals.js";
import AtlasRoute from "./AtlasRoute.js";
import HouseholdRoute from "./HouseholdRoute.js";

import styles from "./VaultRoute.module.css";

export interface VaultRouteProps {
  page?: OpsPage;
}

function mergedState(
  census: OpsState | undefined,
  roster: OpsState | undefined
): OpsState {
  if (census === "error") return "error";
  if (census === undefined || roster === undefined) return "loading";
  if (census === "loading" && roster === "loading") return "loading";
  if (census === "full" || roster === "full") return "full";
  if (census === "loading" || roster === "loading") return "ready";
  if (census === "empty" && roster === "empty") return "empty";
  return "ready";
}

export default function VaultRoute({
  page = "atlas",
}: VaultRouteProps = {}): JSX.Element {
  const { navigate } = useShellActions();
  const [census, setCensus] = useState<AtlasReport | null>(null);
  const [roster, setRoster] = useState<HouseholdReport | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>(() => {
    const start = sectionsStartCollapsed();
    return { holds: start, lives: start, reach: start };
  });
  const toggle = useCallback((key: string) => {
    setClosed((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const state = mergedState(census?.state, roster?.state);

  const count = [census?.count, roster?.custody].filter(Boolean).join(" · ");

  const health = useMemo(
    () =>
      roster && roster.pendingCount > 0
        ? roster.health
        : (census?.health ?? roster?.health ?? null),
    [census?.health, roster]
  );

  useEffect(() => {
    publishRouteSignals(page, {
      state,
      ...(count ? { count } : {}),
      ...(health ? { health } : {}),
      ...(roster && roster.pendingCount > 0 ? { tone: "seam" as const } : {}),
    });
  }, [count, health, page, roster, state]);
  useEffect(() => () => clearRouteSignals(page), [page]);

  useEffect(() => {
    if (!roster) return;
    publishRouteVerbs(page, {
      onCommit: roster.openPairing,
      onSecondary: roster.reviewPending,
    });
  }, [page, roster]);

  return (
    <PageScroll>
      <div className={styles.page}>
        <AtlasRoute
          embedded
          collapsed={closed.holds === true}
          onReport={setCensus}
          onToggle={() => toggle("holds")}
        />
        <VaultReachSection
          collapsed={closed.reach === true}
          onOpenApprovals={() => navigate({ kind: "approvals" })}
          onOpenEnrichment={() =>
            navigate({ kind: "settings", page: "enrichment" })
          }
          onToggle={() => toggle("reach")}
        />
        <HouseholdRoute
          embedded
          collapsed={closed.lives === true}
          onReport={setRoster}
          records={census?.records ?? null}
          onToggle={() => toggle("lives")}
        />
      </div>
    </PageScroll>
  );
}
