import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import {
  decideOutboxItem,
  decideScopeRequest,
  getNotifications,
  getReview,
  listOutboxGrants,
  revokeOutboxGrant,
  subscribeNotificationsChanges,
  updateNotice,
} from "../../../gateway-client-outbox.js";
import {
  enableWebPushWake,
  syncWebNotifications,
} from "../../../gateway-client-push.js";
import {
  confirmVaultParked,
  listAgents,
  revokeVaultGrant,
  vaultApps,
} from "../../../gateway-client-vault.js";
import ApprovalsScreen from "../../screens/ApprovalsScreen.js";
import { groupGrantsByStore } from "../../screens/privacyStores.js";
import type { StoreHolderDTO } from "../../screens/privacyStores.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";
import { useCachedQuery } from "../queryCache.js";
import { PageEmpty, PageSkeleton } from "../status.js";
import {
  buildGrantRow,
  buildActivityRow,
  collapseAdjacentActivity,
  buildNeedsAuthRow,
  buildOutboxRow,
  buildParkedRow,
  buildScopeRequestRow,
} from "./approvalsData.js";

/** Initial review-feed page size; "See all" raises the in-place cap (issue #552). */
const REVIEW_LIMIT_DEFAULT = 20;
const REVIEW_LIMIT_SEE_ALL = 200;

/** The route's whole payload — one fetch triple, so the last-good copy the
 *  route holds across refetches has a name. */
interface Approvals {
  notifications: Awaited<ReturnType<typeof getNotifications>>;
  grants: Awaited<ReturnType<typeof listOutboxGrants>>;
  review: Awaited<ReturnType<typeof getReview>>;
  /** The store-ledger's raw ingredients (issue #708 A2) — kept as the wire
   *  shapes here; `groupGrantsByStore` reshapes them at render time so a
   *  revoke's optimistic edit (below) only has to splice one grant out of
   *  one app/agent's list, not re-derive the whole grouping. */
  apps: Awaited<ReturnType<typeof vaultApps>>;
  agents: Awaited<ReturnType<typeof listAgents>>;
}

async function loadApprovals(reviewLimit: number): Promise<Approvals> {
  const [notifications, grants, review, apps, agents] = await Promise.all([
    getNotifications(true),
    listOutboxGrants(),
    getReview(reviewLimit),
    vaultApps(),
    listAgents(),
  ]);
  return { notifications, grants, review, apps, agents };
}

// React-owned Notifications route (issues #306/#308/#647) — the desktop UI over the
// vault's outbox/blocking/scope-request/grant surface, which shipped with no
// renderer consumer at all. Loads `GET /_vault/blocking` (the unified notifications)
// + `GET /_vault/outbox-grants` (standing rules), maps the wire rows to the
// screen's DTOs (approvalsData.ts), and wires every decision back over
// `gateway-client-outbox.ts`. Deny/revoke ride the shared confirm overlay,
// same split as HomeRoute's delete flow.
export default function ApprovalsRoute(): JSX.Element {
  const { confirm, showToast, navigate } = useShellActions();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reviewLimit, setReviewLimit] = useState(REVIEW_LIMIT_DEFAULT);

  // The outbox decision an `outbox` notice deep-links to (#647 D10). The
  // nonce makes a repeat tap a fresh request; the screen owns the resulting
  // chip/expansion move.
  const [focusOutbox, setFocusOutbox] = useState<{
    itemId: string | null;
    nonce: number;
  } | null>(null);

  // Cached and stale-while-revalidate (issue #659). Two things follow. An SSE
  // doorbell or a decision revalidates BEHIND the rendered page, so nothing the
  // owner is in the middle of — half-edited outbox artifact text, the expanded
  // row, the "always allow" checkbox, the active chip — is thrown away. And
  // leaving Notifications and coming back paints the last known state at once
  // instead of a spinner while the triple round-trips again.
  const { state, refresh, mutate } = useCachedQuery(
    `approvals:${reviewLimit}`,
    () => loadApprovals(reviewLimit)
  );

  // Stable across renders so the SSE subscription below never has to tear
  // down and re-open just because the component re-rendered.
  const reload = useCallback((): void => void refresh(), [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    void subscribeNotificationsChanges(reload, controller.signal).catch(() => {
      // The sidebar's shared 60s poll is the fallback when SSE is unavailable.
    });
    // Opening Notifications is the relevant owner gesture for notification consent.
    // Never prompt at app launch; once granted, register the opaque wake relay
    // and compose any current content locally from the authenticated payload.
    void enableWebPushWake(true)
      .then((enabled) => (enabled ? syncWebNotifications() : Promise.resolve()))
      .catch(() => undefined);
    return () => controller.abort();
  }, [reload]);

  /**
   * Run one decision. The row leaves the page the moment the owner decides
   * (issue #659) — `apply` is the local edit describing that — and the wire
   * call confirms it; a rejection restores the page exactly as it was and says
   * why. `apply` is omitted where the decision has no single obvious local
   * consequence, in which case this is a plain commit-then-revalidate.
   */
  const runDecision = async (
    id: string,
    action: () => Promise<void>,
    apply: (previous: Approvals) => Approvals = (previous) => previous
  ): Promise<void> => {
    setBusyId(id);
    try {
      await mutate(apply, action);
    } catch (error) {
      showToast(
        `That didn’t go through: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBusyId(null);
    }
  };

  /** Drop one pending decision from the blocking summary, by list and id. */
  const withoutDecision = (
    previous: Approvals,
    list: "outbox" | "parked" | "scopeRequests",
    id: string
  ): Approvals => {
    const decisions = previous.notifications.decisions;
    const remaining =
      list === "outbox"
        ? decisions.outbox.filter((item) => item.itemId !== id)
        : list === "parked"
          ? decisions.parked.filter((item) => item.invocationId !== id)
          : decisions.scopeRequests.filter((item) => item.requestId !== id);
    const dropped =
      (list === "outbox"
        ? decisions.outbox.length
        : list === "parked"
          ? decisions.parked.length
          : decisions.scopeRequests.length) - remaining.length;
    return {
      ...previous,
      notifications: {
        ...previous.notifications,
        decisions: {
          ...decisions,
          [list]: remaining,
          count: Math.max(0, decisions.count - dropped),
        },
      },
    };
  };

  const reasonFor = (outcome: {
    status: string;
    reason?: string;
  }): string | undefined =>
    outcome.status === "executed" || outcome.status === "replayed"
      ? undefined
      : outcome.reason;

  const handleApproveOutbox = (
    itemId: string,
    alwaysAllow: boolean,
    artifact?: Record<string, unknown>
  ): void => {
    void runDecision(
      itemId,
      async () => {
        const outcome = await decideOutboxItem({
          itemId,
          decision: "approve",
          alwaysAllow,
          ...(artifact ? { artifact } : {}),
        });
        const reason = reasonFor(outcome);
        if (reason) throw new Error(reason);
        showToast(
          artifact
            ? "Approved with your edits."
            : alwaysAllow
              ? "Approved — future sends like this go through automatically."
              : "Approved."
        );
      },
      (previous) => withoutDecision(previous, "outbox", itemId)
    );
  };

  const handleDenyOutbox = (itemId: string): void => {
    void confirm({
      title: "Discard this outbox item?",
      message: "Nothing will be sent. This can’t be undone.",
      confirmLabel: "Discard",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void runDecision(
        itemId,
        async () => {
          const outcome = await decideOutboxItem({
            itemId,
            decision: "discard",
          });
          const reason = reasonFor(outcome);
          if (reason) throw new Error(reason);
          showToast("Discarded — nothing was sent.");
        },
        (previous) => withoutDecision(previous, "outbox", itemId)
      );
    });
  };

  const handleConfirmParked = (
    invocationId: string,
    approve: boolean
  ): void => {
    const proceed = (): void => {
      void runDecision(
        invocationId,
        async () => {
          await confirmVaultParked({ invocationId, approve });
          showToast(approve ? "Approved." : "Denied.");
        },
        (previous) => withoutDecision(previous, "parked", invocationId)
      );
    };
    if (approve) {
      proceed();
      return;
    }
    void confirm({
      title: "Deny this request?",
      message: "The parked invocation will be denied and can’t be replayed.",
      confirmLabel: "Deny",
      danger: true,
    }).then((ok) => ok && proceed());
  };

  const handleDecideScopeRequest = (
    requestId: string,
    approve: boolean
  ): void => {
    const proceed = (): void => {
      void runDecision(
        requestId,
        async () => {
          await decideScopeRequest({ requestId, approve });
          showToast(approve ? "Scope approved." : "Scope request denied.");
        },
        (previous) => withoutDecision(previous, "scopeRequests", requestId)
      );
    };
    if (approve) {
      proceed();
      return;
    }
    void confirm({
      title: "Deny this scope request?",
      message:
        "The app keeps its current access; it won’t be re-asked for this widening.",
      confirmLabel: "Deny",
      danger: true,
    }).then((ok) => ok && proceed());
  };

  const handleRevokeGrant = (grantId: string): void => {
    void confirm({
      title: "Revoke this standing grant?",
      message:
        "Future items like this park for your review again; anything already approved but undrained reparks too.",
      confirmLabel: "Revoke",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void runDecision(
        grantId,
        async () => {
          const outcome = await revokeOutboxGrant(grantId);
          const reason = reasonFor(outcome);
          if (reason) throw new Error(reason);
          showToast("Grant revoked.");
        },
        // The row is filtered on `revokedAt` below, so stamping it is what
        // makes the standing rule leave the list on the click.
        (previous) => ({
          ...previous,
          grants: previous.grants.map((grant) =>
            grant.grantId === grantId
              ? { ...grant, revokedAt: new Date().toISOString() }
              : grant
          ),
        })
      );
    });
  };

  /**
   * Revoke one store-ledger holder (issue #708 A2). The ledger's "switch"
   * strikes the row through rather than removing it — that local
   * revoked-state bookkeeping lives in `ApprovalsScreen`, so this handler's
   * only job is the wire call plus splicing the grant out of `apps`/`agents`
   * so a background revalidate doesn't resurrect it before the screen's own
   * snapshot has taken over showing the struck-through row.
   */
  const handleRevokeStoreGrant = (holder: StoreHolderDTO): void => {
    void runDecision(
      holder.grantId,
      async () => {
        await revokeVaultGrant({ grantId: holder.grantId });
        showToast(`Revoked ${holder.holderLabel}’s access.`);
      },
      (previous) => ({
        ...previous,
        apps: previous.apps.map((app) =>
          app.appId === holder.holderId
            ? {
                ...app,
                grants: app.grants.filter((g) => g.grantId !== holder.grantId),
              }
            : app
        ),
        agents: previous.agents.map((agent) =>
          agent.agentId === holder.holderId
            ? {
                ...agent,
                grants: agent.grants.filter(
                  (g) => g.grantId !== holder.grantId
                ),
              }
            : agent
        ),
      })
    );
  };

  const handleNoticeAction = (
    noticeId: string,
    action: "read" | "archive"
  ): void => {
    void runDecision(
      noticeId,
      async () => {
        await updateNotice(noticeId, action);
      },
      (previous) => ({
        ...previous,
        notifications: {
          ...previous.notifications,
          notices:
            action === "archive"
              ? previous.notifications.notices.filter(
                  (notice) => notice.noticeId !== noticeId
                )
              : previous.notifications.notices.map((notice) =>
                  notice.noticeId === noticeId && notice.readAt === null
                    ? { ...notice, readAt: new Date().toISOString() }
                    : notice
                ),
        },
      })
    );
  };

  if (state.status === "loading") {
    return (
      <PageScroll>
        <PageSkeleton rows={4} label="Loading Notifications…" />
      </PageScroll>
    );
  }
  if (state.status === "error") {
    return (
      <PageScroll>
        <PageEmpty message={`Couldn’t load Notifications: ${state.error}`} />
      </PageScroll>
    );
  }

  const { notifications, grants, review, apps, agents } = state.data;
  const blocking = notifications.decisions;
  const activity = collapseAdjacentActivity(review.map(buildActivityRow));
  const storeGrants = groupGrantsByStore(apps, agents);
  // Truncated when the wire returned a full page at the current limit —
  // "See all" raises the cap in place (no separate audit-log screen).
  const activityTruncated =
    review.length >= reviewLimit && reviewLimit < REVIEW_LIMIT_SEE_ALL;
  return (
    <PageScroll>
      <ApprovalsScreen
        outbox={blocking.outbox.map(buildOutboxRow)}
        needsAuth={blocking.needsAuth.map(buildNeedsAuthRow)}
        parked={blocking.parked.map(buildParkedRow)}
        scopeRequests={blocking.scopeRequests.map(buildScopeRequestRow)}
        grants={grants.filter((g) => g.revokedAt === null).map(buildGrantRow)}
        storeGrants={storeGrants}
        activity={activity}
        notices={notifications.notices.map((notice) => ({
          ...notice,
          sourceType:
            notice.detail.sourceType === "automation" ||
            notice.detail.sourceType === "agent" ||
            notice.detail.sourceType === "app"
              ? notice.detail.sourceType
              : "app",
          detailText:
            typeof notice.detail.error === "string"
              ? notice.detail.error
              : typeof notice.detail.detail === "string"
                ? notice.detail.detail
                : null,
          sourceLabel:
            typeof notice.detail.automationRef === "string"
              ? notice.detail.automationRef
              : typeof notice.detail.actor === "string"
                ? notice.detail.actor
                : typeof notice.detail.gatewayLabel === "string"
                  ? notice.detail.gatewayLabel
                  : null,
        }))}
        activityTruncated={activityTruncated}
        busyId={busyId}
        onApproveOutbox={handleApproveOutbox}
        onDenyOutbox={handleDenyOutbox}
        onOpenSettings={() => navigate({ kind: "connectors" })}
        onConfirmParked={handleConfirmParked}
        onDecideScopeRequest={handleDecideScopeRequest}
        onRevokeGrant={handleRevokeGrant}
        onRevokeStoreGrant={handleRevokeStoreGrant}
        onReadNotice={(id) => handleNoticeAction(id, "read")}
        onArchiveNotice={(id) => handleNoticeAction(id, "archive")}
        onOpenNotice={(notice) => {
          const ref = notice.detail.automationRef;
          const appId = notice.detail.appId;
          // Recognition controls are the built-in automation recipes. A
          // refusal therefore opens its recipe when the notice identifies
          // one, and otherwise opens the collapsed Recognition fleet.
          if (notice.kind.startsWith("commons-")) {
            // Steward absence, commons growth and the identity fault
            // (commons-notices.ts) are all acted on from People & circles on
            // Household — the surface that offers the recovery ceremony.
            navigate({ kind: "household" });
          } else if (typeof ref === "string") {
            navigate({ kind: "automation-view", automationId: ref });
          } else if (typeof notice.detail.enrichDomain === "string") {
            navigate({ kind: "automations" });
          } else if (notice.kind === "gateway-health") {
            // Legacy rows only (issue #665): health no longer projects into the
            // Notifications, but cards written by an earlier build survive in vault.db
            // until archived, and Alerts is still exactly where they point.
            navigate({ kind: "gateway", tab: "alerts" });
          } else if (typeof appId === "string") {
            navigate({ kind: "app", id: appId });
          } else if (notice.kind === "outbox") {
            // We are already ON Notifications, so navigating here was a no-op. The
            // gateway ships the staged item's id (outbox-executor.ts) — use
            // it to put that decision in front of the owner instead.
            const itemId = notice.detail.itemId;
            setFocusOutbox((prev) => ({
              itemId:
                typeof itemId === "string" && itemId !== "" ? itemId : null,
              nonce: (prev?.nonce ?? 0) + 1,
            }));
          } else {
            navigate({ kind: "approvals" });
          }
        }}
        onSeeAllActivity={() => setReviewLimit(REVIEW_LIMIT_SEE_ALL)}
        focusOutbox={focusOutbox}
      />
    </PageScroll>
  );
}
