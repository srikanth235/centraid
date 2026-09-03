import type { ReactNode } from "react";

import {
  openTriage,
  triageAnswer,
  triageCurrent,
} from "../_shared/triage-session.ts";
import type { TriageSession } from "../_shared/triage-session.ts";
import { DuplicateReviewView } from "./components/DuplicateReview.tsx";
import { DuplicatesView } from "./components/Duplicates.tsx";
import { trashDuplicateAssets } from "./duplicates-actions.ts";
import type { Rung } from "./layout.ts";
import type { DuplicateCluster } from "./types.ts";

type Root = { render: (node: ReactNode) => void };

export function createDuplicates({
  gridRoot,
  refresh,
  ownScope,
  rung,
}: {
  gridRoot: Root;
  refresh: () => Promise<void>;
  ownScope: () => string | null;
  rung: () => Rung;
}) {
  let clusters: DuplicateCluster[] | null = null; // null = not yet loaded
  let loading = false;
  const selected = new Set<string>();

  let session: TriageSession<DuplicateCluster> | null = null;
  let busy = false;
  const keptByCluster = new Map<string, string>();

  function renderDuplicates() {
    const cluster = session ? triageCurrent(session) : undefined;
    if (cluster && session) {
      gridRoot.render(
        <DuplicateReviewView
          cluster={cluster}
          index={session.cursor}
          total={session.total}
          rung={rung()}
          keptId={keptByCluster.get(cluster.key) ?? null}
          busy={busy}
          onKeep={(assetId) => {
            keptByCluster.set(cluster.key, assetId);
            renderDuplicates();
          }}
          onKeepAll={() => {
            if (busy) return;
            advance("kept-all");
          }}
          onTrashRest={(assetIds) => void resolveCluster(cluster, assetIds)}
        />
      );
      return;
    }
    gridRoot.render(
      <DuplicatesView
        clusters={clusters}
        loading={loading}
        rung={rung()}
        selected={selected}
        onToggle={(assetId) => {
          if (selected.has(assetId)) selected.delete(assetId);
          else selected.add(assetId);
          renderDuplicates();
        }}
        onTrashSelected={async () => {
          const ids = [...selected];
          await trashDuplicateAssets(ids, { refresh, scope: ownScope() });
          dropTrashed(ids);
          selected.clear();
          renderDuplicates();
        }}
      />
    );
  }

  function dropTrashed(ids: readonly string[]): void {
    const trashedIds = new Set(ids);
    clusters = (clusters ?? [])
      .map((c) => ({
        ...c,
        assets: c.assets.filter((a) => !trashedIds.has(a.asset_id)),
      }))
      .filter((c) => c.assets.length >= 2);
  }

  function advance(outcome: "trashed" | "kept-all"): void {
    if (!session) return;
    const stepped = triageAnswer(session, outcome);
    session = triageCurrent(stepped) === undefined ? null : stepped;
    renderDuplicates();
  }

  async function resolveCluster(
    cluster: DuplicateCluster,
    assetIds: string[]
  ): Promise<void> {
    if (busy) return;
    busy = true;
    renderDuplicates();
    try {
      await trashDuplicateAssets(assetIds, { refresh, scope: ownScope() });
      dropTrashed(assetIds);
      keptByCluster.delete(cluster.key);
    } finally {
      busy = false;
    }
    advance("trashed");
  }

  async function ensureLoaded() {
    if (clusters != null || loading) return;
    loading = true;
    renderDuplicates();
    let data: { clusters?: DuplicateCluster[] } | undefined;
    try {
      data = await window.centraid.read<{ clusters?: DuplicateCluster[] }>({
        query: "duplicates",
        input: {},
      });
    } catch {
      data = undefined;
    }
    clusters = data?.clusters ?? [];
    loading = false;
    renderDuplicates();
  }

  function openReview(): void {
    const loaded = clusters ?? [];
    if (loaded.length === 0) return;
    session = openTriage(loaded);
    busy = false;
    keptByCluster.clear();
    renderDuplicates();
  }

  function exitReview(): void {
    if (!session) return;
    session = null;
    keptByCluster.clear();
    renderDuplicates();
  }

  function reviewing(): boolean {
    return session != null;
  }

  function invalidate() {
    clusters = null;
    selected.clear();
    session = null;
    keptByCluster.clear();
  }

  function count(): number | null {
    return clusters?.length ?? null;
  }

  return {
    ensureLoaded,
    renderDuplicates,
    invalidate,
    count,
    openReview,
    exitReview,
    reviewing,
  };
}
