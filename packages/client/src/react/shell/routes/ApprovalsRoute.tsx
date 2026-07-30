import { useEffect, useState } from "react";
import type { JSX } from "react";

import {
  decideOutboxItem,
  decideScopeRequest,
  getInbox,
  getReview,
  listOutboxGrants,
  revokeOutboxGrant,
  subscribeInboxChanges,
  updateInboxNotice,
} from "../../../gateway-client-outbox.js";
import {
  enableWebPushWake,
  syncWebInboxNotifications,
} from "../../../gateway-client-push.js";
import { confirmVaultParked } from "../../../gateway-client-vault.js";
import ApprovalsScreen from "../../screens/ApprovalsScreen.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";
import { PageEmpty, PageLoading } from "../status.js";
import { useAsyncData } from "../useAsyncData.js";
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

// React-owned Inbox route (issues #306/#308/#647) — the desktop UI over the
// vault's outbox/blocking/scope-request/grant surface, which shipped with no
// renderer consumer at all. Loads `GET /_vault/blocking` (the unified inbox)
// + `GET /_vault/outbox-grants` (standing rules), maps the wire rows to the
// screen's DTOs (approvalsData.ts), and wires every decision back over
// `gateway-client-outbox.ts`. Deny/revoke ride the shared confirm overlay,
// same split as HomeRoute's delete flow.
export default function ApprovalsRoute(): JSX.Element {
  const { confirm, showToast, navigate } = useShellActions();
  const [busyId, setBusyId] = useState<string | null>(null);
  // Bumping this forces useAsyncData to re-fetch. SSE rings this same doorbell;
  // explicit decisions still reload immediately.
  const [refreshTick, setRefreshTick] = useState(0);
  const [reviewLimit, setReviewLimit] = useState(REVIEW_LIMIT_DEFAULT);

  const state = useAsyncData(async () => {
    const [inbox, grants, review] = await Promise.all([
      getInbox(true),
      listOutboxGrants(),
      getReview(reviewLimit),
    ]);
    return { inbox, grants, review };
  }, [refreshTick, reviewLimit]);

  const reload = (): void => setRefreshTick((t) => t + 1);
  useEffect(() => {
    const controller = new AbortController();
    void subscribeInboxChanges(reload, controller.signal).catch(() => {
      // The sidebar's shared 60s poll is the fallback when SSE is unavailable.
    });
    // Opening Inbox is the relevant owner gesture for notification consent.
    // Never prompt at app launch; once granted, register the opaque wake relay
    // and compose any current content locally from the authenticated payload.
    void enableWebPushWake(true)
      .then((enabled) =>
        enabled ? syncWebInboxNotifications() : Promise.resolve()
      )
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const runDecision = async (
    id: string,
    action: () => Promise<void>
  ): Promise<void> => {
    setBusyId(id);
    try {
      await action();
      reload();
    } catch (error) {
      showToast(
        `That didn’t go through: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBusyId(null);
    }
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
    void runDecision(itemId, async () => {
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
    });
  };

  const handleDenyOutbox = (itemId: string): void => {
    void confirm({
      title: "Discard this outbox item?",
      message: "Nothing will be sent. This can’t be undone.",
      confirmLabel: "Discard",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void runDecision(itemId, async () => {
        const outcome = await decideOutboxItem({ itemId, decision: "discard" });
        const reason = reasonFor(outcome);
        if (reason) throw new Error(reason);
        showToast("Discarded — nothing was sent.");
      });
    });
  };

  const handleConfirmParked = (
    invocationId: string,
    approve: boolean
  ): void => {
    const proceed = (): void => {
      void runDecision(invocationId, async () => {
        await confirmVaultParked({ invocationId, approve });
        showToast(approve ? "Approved." : "Denied.");
      });
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
      void runDecision(requestId, async () => {
        await decideScopeRequest({ requestId, approve });
        showToast(approve ? "Scope approved." : "Scope request denied.");
      });
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
      void runDecision(grantId, async () => {
        const outcome = await revokeOutboxGrant(grantId);
        const reason = reasonFor(outcome);
        if (reason) throw new Error(reason);
        showToast("Grant revoked.");
      });
    });
  };

  const handleNoticeAction = (
    noticeId: string,
    action: "read" | "archive"
  ): void => {
    void runDecision(noticeId, async () => {
      await updateInboxNotice(noticeId, action);
    });
  };

  if (state.status === "loading") {
    return (
      <PageScroll>
        <PageLoading label="Loading Inbox…" />
      </PageScroll>
    );
  }
  if (state.status === "error") {
    return (
      <PageScroll>
        <PageEmpty message={`Couldn’t load Inbox: ${state.error}`} />
      </PageScroll>
    );
  }

  const { inbox, grants, review } = state.data;
  const blocking = inbox.decisions;
  const activity = collapseAdjacentActivity(review.map(buildActivityRow));
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
        activity={activity}
        notices={inbox.notices.map((notice) => ({
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
        onReadNotice={(id) => handleNoticeAction(id, "read")}
        onArchiveNotice={(id) => handleNoticeAction(id, "archive")}
        onOpenNotice={(notice) => {
          const ref = notice.detail.automationRef;
          const appId = notice.detail.appId;
          if (typeof ref === "string") {
            navigate({ kind: "automation-view", automationId: ref });
          } else if (notice.kind === "gateway-health") {
            navigate({ kind: "gateway", tab: "alerts" });
          } else if (typeof appId === "string") {
            navigate({ kind: "app", id: appId });
          } else if (notice.kind === "outbox") {
            navigate({ kind: "approvals" });
          } else {
            navigate({ kind: "approvals" });
          }
        }}
        onSeeAllActivity={() => setReviewLimit(REVIEW_LIMIT_SEE_ALL)}
      />
    </PageScroll>
  );
}
