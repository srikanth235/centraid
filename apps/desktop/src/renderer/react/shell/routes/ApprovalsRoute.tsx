import { type JSX, useState } from 'react';
import {
  decideOutboxItem,
  decideScopeRequest,
  getBlocking,
  listOutboxGrants,
  revokeOutboxGrant,
} from '../../../gateway-client-outbox.js';
import { confirmVaultParked } from '../../../gateway-client-vault.js';
import ApprovalsScreen from '../../screens/ApprovalsScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { PageEmpty, PageLoading } from '../status.js';
import { useAsyncData } from '../useAsyncData.js';
import {
  buildGrantRow,
  buildNeedsAuthRow,
  buildOutboxRow,
  buildParkedRow,
  buildScopeRequestRow,
} from './approvalsData.js';

// React-owned Approvals route (issues #306/#308) — the desktop UI over the
// vault's outbox/blocking/scope-request/grant surface, which shipped with no
// renderer consumer at all. Loads `GET /_vault/blocking` (the unified inbox)
// + `GET /_vault/outbox-grants` (standing rules), maps the wire rows to the
// screen's DTOs (approvalsData.ts), and wires every decision back over
// `gateway-client-outbox.ts`. Deny/revoke ride the shared confirm overlay,
// same split as HomeRoute's delete flow.
export default function ApprovalsRoute(): JSX.Element {
  const { confirm, showToast, navigate } = useShellActions();
  const [busyId, setBusyId] = useState<string | null>(null);
  // Bumping this forces useAsyncData to re-fetch — there's no gateway push
  // channel for the vault plane yet, so every decision reloads explicitly.
  const [refreshTick, setRefreshTick] = useState(0);

  const state = useAsyncData(async () => {
    const [blocking, grants] = await Promise.all([getBlocking(), listOutboxGrants()]);
    return { blocking, grants };
  }, [refreshTick]);

  const reload = (): void => setRefreshTick((t) => t + 1);

  const runDecision = async (id: string, action: () => Promise<void>): Promise<void> => {
    setBusyId(id);
    try {
      await action();
      reload();
    } catch (err) {
      showToast(`That didn’t go through: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const reasonFor = (outcome: {
    status: string;
    reason?: string;
  }): string | undefined =>
    outcome.status === 'executed' || outcome.status === 'replayed' ? undefined : outcome.reason;

  const handleApproveOutbox = (
    itemId: string,
    alwaysAllow: boolean,
    artifact?: Record<string, unknown>,
  ): void => {
    void runDecision(itemId, async () => {
      const outcome = await decideOutboxItem({
        itemId,
        decision: 'approve',
        alwaysAllow,
        ...(artifact ? { artifact } : {}),
      });
      const reason = reasonFor(outcome);
      if (reason) throw new Error(reason);
      showToast(
        artifact
          ? 'Approved with your edits.'
          : alwaysAllow
            ? 'Approved — future sends like this go through automatically.'
            : 'Approved.',
      );
    });
  };

  const handleDenyOutbox = (itemId: string): void => {
    void confirm({
      title: 'Discard this outbox item?',
      message: 'Nothing will be sent. This can’t be undone.',
      confirmLabel: 'Discard',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void runDecision(itemId, async () => {
        const outcome = await decideOutboxItem({ itemId, decision: 'discard' });
        const reason = reasonFor(outcome);
        if (reason) throw new Error(reason);
        showToast('Discarded — nothing was sent.');
      });
    });
  };

  const handleConfirmParked = (invocationId: string, approve: boolean): void => {
    const proceed = (): void => {
      void runDecision(invocationId, async () => {
        await confirmVaultParked({ invocationId, approve });
        showToast(approve ? 'Approved.' : 'Denied.');
      });
    };
    if (approve) {
      proceed();
      return;
    }
    void confirm({
      title: 'Deny this request?',
      message: 'The parked invocation will be denied and can’t be replayed.',
      confirmLabel: 'Deny',
      danger: true,
    }).then((ok) => ok && proceed());
  };

  const handleDecideScopeRequest = (requestId: string, approve: boolean): void => {
    const proceed = (): void => {
      void runDecision(requestId, async () => {
        await decideScopeRequest({ requestId, approve });
        showToast(approve ? 'Scope approved.' : 'Scope request denied.');
      });
    };
    if (approve) {
      proceed();
      return;
    }
    void confirm({
      title: 'Deny this scope request?',
      message: 'The app keeps its current access; it won’t be re-asked for this widening.',
      confirmLabel: 'Deny',
      danger: true,
    }).then((ok) => ok && proceed());
  };

  const handleRevokeGrant = (grantId: string): void => {
    void confirm({
      title: 'Revoke this standing grant?',
      message: 'Future items like this park for your review again; anything already approved but undrained reparks too.',
      confirmLabel: 'Revoke',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void runDecision(grantId, async () => {
        const outcome = await revokeOutboxGrant(grantId);
        const reason = reasonFor(outcome);
        if (reason) throw new Error(reason);
        showToast('Grant revoked.');
      });
    });
  };

  if (state.status === 'loading') {
    return (
      <PageScroll>
        <PageLoading label="Loading approvals…" />
      </PageScroll>
    );
  }
  if (state.status === 'error') {
    return (
      <PageScroll>
        <PageEmpty message={`Couldn’t load approvals: ${state.error}`} />
      </PageScroll>
    );
  }

  const { blocking, grants } = state.data;
  return (
    <PageScroll>
      <ApprovalsScreen
        outbox={blocking.outbox.map(buildOutboxRow)}
        needsAuth={blocking.needsAuth.map(buildNeedsAuthRow)}
        parked={blocking.parked.map(buildParkedRow)}
        scopeRequests={blocking.scopeRequests.map(buildScopeRequestRow)}
        grants={grants.filter((g) => g.revokedAt === null).map(buildGrantRow)}
        busyId={busyId}
        onApproveOutbox={handleApproveOutbox}
        onDenyOutbox={handleDenyOutbox}
        onOpenSettings={() => navigate({ kind: 'settings' })}
        onConfirmParked={handleConfirmParked}
        onDecideScopeRequest={handleDecideScopeRequest}
        onRevokeGrant={handleRevokeGrant}
      />
    </PageScroll>
  );
}
