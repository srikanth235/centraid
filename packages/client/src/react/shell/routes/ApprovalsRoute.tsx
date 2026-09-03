import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import {
  APPROVALS_ERROR_BODY,
  APPROVALS_ERROR_TITLE,
} from "../../../approvals-copy.js";
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
  listEnrichEgressConsent,
  revokeVaultGrant,
  vaultApps,
} from "../../../gateway-client-vault.js";
import { RETRY_ACTION } from "../../../surface-copy.js";
import ApprovalsScreen from "../../screens/ApprovalsScreen.js";
import { groupGrantsByStore } from "../../screens/privacyStores.js";
import type { StoreHolderDTO } from "../../screens/privacyStores.js";
import NoteBlock from "../../ui/NoteBlock.js";
import PanelBlock from "../../ui/PanelBlock.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";
import { useCachedQuery } from "../queryCache.js";
import {
  clearRouteSignals,
  publishRouteSignals,
  publishRouteVerbs,
} from "../routeVitals.js";
import { PageSkeleton } from "../status.js";
import {
  approvalsCountLine,
  approvalsHealth,
  approvalsState,
  buildGrantRow,
  buildActivityRow,
  buildEnrichConsentRow,
  collapseAdjacentActivity,
  buildNeedsAuthRow,
  buildOutboxRow,
  buildParkedRow,
  buildScopeRequestRow,
} from "./approvalsData.js";

const REVIEW_LIMIT_DEFAULT = 20;
const REVIEW_LIMIT_SEE_ALL = 200;

interface Approvals {
  notifications: Awaited<ReturnType<typeof getNotifications>>;
  grants: Awaited<ReturnType<typeof listOutboxGrants>>;
  review: Awaited<ReturnType<typeof getReview>>;
  apps: Awaited<ReturnType<typeof vaultApps>>;
  agents: Awaited<ReturnType<typeof listAgents>>;
  enrichConsent: Awaited<ReturnType<typeof listEnrichEgressConsent>> | null;
}

async function loadApprovals(reviewLimit: number): Promise<Approvals> {
  const [notifications, grants, review, apps, agents, enrichConsent] =
    await Promise.all([
      getNotifications(true),
      listOutboxGrants(),
      getReview(reviewLimit),
      vaultApps(),
      listAgents(),
      listEnrichEgressConsent().catch(() => null),
    ]);
  return { notifications, grants, review, apps, agents, enrichConsent };
}

const DISCARD_CONSEQUENCE = "Nothing will be sent. This can’t be undone.";

export default function ApprovalsRoute(): JSX.Element {
  const { showToast, navigate } = useShellActions();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reviewLimit, setReviewLimit] = useState(REVIEW_LIMIT_DEFAULT);
  const [reviewAll, setReviewAll] = useState<{ nonce: number } | null>(null);

  const [focusOutbox, setFocusOutbox] = useState<{
    itemId: string | null;
    nonce: number;
  } | null>(null);

  const [refusal, setRefusal] = useState<{
    itemId: string | null;
    message: string;
    nonce: number;
  } | null>(null);
  const refusals = useRef(0);

  const { state, refresh, mutate } = useCachedQuery(
    `approvals:${reviewLimit}`,
    () => loadApprovals(reviewLimit)
  );

  const reload = useCallback((): void => void refresh(), [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    void subscribeNotificationsChanges(reload, controller.signal).catch(
      () => {}
    );

    void enableWebPushWake(true)
      .then((enabled) => (enabled ? syncWebNotifications() : Promise.resolve()))
      .catch(() => undefined);
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    publishRouteVerbs("approvals", {
      onCommit: () =>
        setReviewAll((prev) => ({ nonce: (prev?.nonce ?? 0) + 1 })),
      onSecondary: () => navigate({ kind: "gateway", tab: "alerts" }),
    });
    return () => clearRouteSignals("approvals");
  }, [navigate]);

  const pending =
    state.status === "ready" ? state.data.notifications.decisions : null;
  const waiting =
    pending === null || state.status !== "ready"
      ? -1
      : pending.outbox.length +
        pending.needsAuth.length +
        pending.parked.length +
        pending.scopeRequests.length +
        state.data.notifications.notices.filter(
          (notice) => notice.archivedAt === null && notice.severity !== "info"
        ).length;
  const standing =
    state.status === "ready"
      ? state.data.grants.filter((grant) => grant.revokedAt === null).length
      : -1;
  const lastReadAt = useRef<number | null>(null);
  useEffect(() => {
    if (state.status === "loading") {
      publishRouteSignals("approvals", { state: "loading" });
      return;
    }
    if (state.status === "error") {
      publishRouteSignals("approvals", {
        state: "error",
        ...(lastReadAt.current === null
          ? {}
          : { lastReadAt: lastReadAt.current }),
      });
      return;
    }
    lastReadAt.current = Date.now();
    const tally = { grants: standing, waiting };
    publishRouteSignals("approvals", {
      count: approvalsCountLine(tally),
      health: approvalsHealth(tally),
      state: approvalsState(tally),
    });
  }, [standing, state.status, waiting]);

  const runDecision = async (
    id: string,
    action: () => Promise<void>,
    apply: (previous: Approvals) => Approvals = (previous) => previous,
    itemId: string | null = null
  ): Promise<void> => {
    setBusyId(id);
    try {
      await mutate(apply, action);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      refusals.current += 1;
      setRefusal({ itemId, message, nonce: refusals.current });
      showToast(`That didn’t go through: ${message}`);
    } finally {
      setBusyId(null);
    }
  };

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
      (previous) => withoutDecision(previous, "outbox", itemId),
      itemId
    );
  };

  const handleDenyOutbox = (itemId: string): void => {
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
      (previous) => withoutDecision(previous, "outbox", itemId),
      itemId
    );
  };

  const handleConfirmParked = (
    invocationId: string,
    approve: boolean
  ): void => {
    void runDecision(
      invocationId,
      async () => {
        await confirmVaultParked({ invocationId, approve });
        showToast(approve ? "Approved." : "Denied.");
      },
      (previous) => withoutDecision(previous, "parked", invocationId)
    );
  };

  const handleDecideScopeRequest = (
    requestId: string,
    approve: boolean
  ): void => {
    void runDecision(
      requestId,
      async () => {
        await decideScopeRequest({ requestId, approve });
        showToast(approve ? "Scope approved." : "Scope request denied.");
      },
      (previous) => withoutDecision(previous, "scopeRequests", requestId)
    );
  };

  const handleRevokeGrant = (grantId: string): void => {
    void runDecision(
      grantId,
      async () => {
        const outcome = await revokeOutboxGrant(grantId);
        const reason = reasonFor(outcome);
        if (reason) throw new Error(reason);
        showToast("Grant revoked.");
      },
      (previous) => ({
        ...previous,
        grants: previous.grants.map((grant) =>
          grant.grantId === grantId
            ? { ...grant, revokedAt: new Date().toISOString() }
            : grant
        ),
      })
    );
  };

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
        <PageSkeleton rows={6} label="Loading Notifications…" />
        <NoteBlock>
          A row knows its shape before its content arrives, so nothing reflows
          when it does.
        </NoteBlock>
      </PageScroll>
    );
  }
  if (state.status === "error") {
    return (
      <PageScroll>
        <PanelBlock
          action={{ label: RETRY_ACTION, onClick: reload }}
          body={APPROVALS_ERROR_BODY}
          eyebrow={APPROVALS_ERROR_TITLE}
          facts={[{ key: "what it said", value: state.error }]}
          tone="net"
          wide
        />
      </PageScroll>
    );
  }

  const { notifications, grants, review, apps, agents, enrichConsent } =
    state.data;
  const blocking = notifications.decisions;
  const activity = collapseAdjacentActivity(review.map(buildActivityRow));
  const storeGrants = groupGrantsByStore(apps, agents);
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
        enrichConsent={(enrichConsent ?? []).map(buildEnrichConsentRow)}
        enrichConsentReadable={enrichConsent !== null}
        discardConsequence={DISCARD_CONSEQUENCE}
        refusal={refusal}
        activity={activity}
        notices={notifications.notices.map((notice) => ({
          ...notice,
          sourceType:
            notice.detail.sourceType === "automation" ||
            notice.detail.sourceType === "agent" ||
            notice.detail.sourceType === "app" ||
            notice.detail.sourceType === "share"
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
                : // Name the sharer: a card about somebody's decision that
                  typeof notice.detail.granterName === "string"
                  ? notice.detail.granterName
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
          if (notice.kind.startsWith("commons-")) {
            navigate({ kind: "household" });
          } else if (typeof ref === "string") {
            navigate({ kind: "automation-view", automationId: ref });
          } else if (typeof notice.detail.enrichDomain === "string") {
            navigate({ kind: "automations" });
          } else if (notice.kind === "gateway-health") {
            navigate({ kind: "gateway", tab: "alerts" });
          } else if (typeof appId === "string") {
            navigate({ kind: "app", id: appId });
          } else if (notice.kind === "outbox") {
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
        onOpenAlertHistory={() => navigate({ kind: "gateway", tab: "alerts" })}
        focusOutbox={focusOutbox}
        reviewAll={reviewAll}
      />
    </PageScroll>
  );
}
