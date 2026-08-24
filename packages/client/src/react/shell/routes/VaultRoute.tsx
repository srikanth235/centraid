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

// Vault — the custody surface (v11). ONE page for what would otherwise be two.
//
// Data answered "what is in here" and Copies answered "which machines hold it",
// and a member with a question about their own data had to know which of those
// two words the answer had been filed under. They are one question asked three
// ways, so they are one page with three sections, in the order the question
// narrows:
//
//   What it holds   — the census, kind by kind, with a bar for scale.
//   Who can reach it— pointers to where consent is actually answered.
//   Where it lives  — vaults, devices, people, and everything across a wire.
//
// This route is the seam. It owns:
//   - the one column everything stacks in (the two halves draw no page frame),
//   - the three disclosures (one closed/open decision, not two),
//   - the ONE publish to the frame's app bar and status line. Two publishers on
//     two channels is two answers behind one bar, and the bar can only draw
//     one; the halves report to this route instead.
//
// `page` is which persisted key mounted it. Both `atlas` and `household`
// resolve here so old pins and old deep links land, and only one is ever
// mounted, so there is only ever one live channel.

export interface VaultRouteProps {
  /** The persisted route key this surface was reached by. */
  page?: OpsPage;
}

/**
 * The surface's state, from its two halves.
 *
 * The STORE is the page's subject, so its error is the page's error; the
 * machines answer separately and still list beneath it, which is the whole
 * "what failed, what is still safe" shape. Loading only while BOTH are still
 * reading — whichever answers first paints, and neither can blank the page by
 * being slow.
 */
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
  // One decision for all three, taken once on mount: on touch they start
  // closed, because "What it holds" alone is forty rows and it would put the
  // section a member came for six screens down.
  const [closed, setClosed] = useState<Record<string, boolean>>(() => {
    const start = sectionsStartCollapsed();
    return { holds: start, lives: start, reach: start };
  });
  const toggle = useCallback((key: string) => {
    setClosed((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const state = mergedState(census?.state, roster?.state);

  // ONE count line for the surface: what it holds, then what holds it. Each
  // clause is omitted rather than guessed while its half is still reading.
  const count = [census?.count, roster?.custody].filter(Boolean).join(" · ");

  // The status line takes the roster's sentence when something is waiting on a
  // decision, and the census's otherwise: a pending pairing is the only thing
  // here a member has to act on, and a health line that reported "Everything
  // is readable" over an unanswered request would bury it.
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
