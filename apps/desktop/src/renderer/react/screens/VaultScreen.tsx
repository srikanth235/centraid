import { useCallback, useEffect, useState, type JSX } from 'react';
import type {
  VaultBridgeProps,
  VaultData,
  VaultGrantDTO,
  VaultParkedDTO,
  VaultScopeDTO,
} from '../bridge.js';
import { relativeTime } from '../format.js';
import { cx } from '../ui/cx.js';
import vault from '../styles/vault.module.css';

const scopeLabel = (s: VaultScopeDTO): string => (s.table ? `${s.schema}.${s.table}` : s.schema);

function Note({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="cd-app-settings-note">{children}</div>;
}

// WHAT the app asked for — why line + requested scopes as chips.
function RequestSection({ block }: { block: VaultBridgeProps['block'] }): JSX.Element {
  return (
    <div className="cd-app-settings-section cd-vault-request">
      <div className={vault.label}>Requested access</div>
      {block.why ? <div className={vault.why}>{block.why}</div> : null}
      <div className={vault.scopes}>
        {block.scopes.map((scope) => (
          <span key={scopeLabel(scope)} className={vault.scope} data-verbs={scope.verbs}>
            <span className="cd-vault-scope-name">{scopeLabel(scope)}</span>
            <span className={vault.scopeVerbs}>{scope.verbs}</span>
          </span>
        ))}
      </div>
      <div className={vault.purpose}>{`Purpose · ${block.purpose}`}</div>
    </div>
  );
}

function GrantSection({
  grants,
  vaultName,
  onGrant,
  onRevoke,
}: {
  grants: VaultGrantDTO[];
  vaultName: string;
  onGrant: () => void;
  onRevoke: (grantId: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <div className={cx('cd-app-settings-section', vault.grants)}>
      <div className={vault.label}>{`Access · ${vaultName}`}</div>
      {grants.length === 0 ? (
        <>
          <Note>No access yet — the vault denies every call until you grant it.</Note>
          <button
            type="button"
            className={vault.grantBtn}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onGrant();
            }}
          >
            Grant access
          </button>
        </>
      ) : (
        grants.map((grant) => (
          <div key={grant.grantId} className={vault.grantRow}>
            <div className={vault.grantText}>
              <div className={vault.grantTitle}>{`Granted · ${grant.purpose ?? 'purpose'}`}</div>
              <div className={vault.grantSub}>
                {grant.scopes.map(scopeLabel).join(' · ') +
                  (grant.expiresAt ? ` · expires ${grant.expiresAt.slice(0, 10)}` : '')}
              </div>
            </div>
            <button
              type="button"
              className={vault.revokeBtn}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                onRevoke(grant.grantId);
              }}
            >
              Revoke
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function ParkedSection({
  parked,
  onConfirm,
}: {
  parked: VaultParkedDTO[];
  onConfirm: (invocationId: string, approve: boolean) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <div className={cx('cd-app-settings-section', vault.parked)}>
      <div className={vault.label}>Waiting for your say-so</div>
      {parked.map((entry) => (
        <div key={entry.invocationId} className={vault.parkedCard}>
          <div className={vault.parkedHead}>
            <span className={vault.parkedCommand}>{entry.command}</span>
            <span className={vault.parkedWhen}>{relativeTime(entry.parkedAt)}</span>
          </div>
          <pre className={vault.parkedInput}>{JSON.stringify(entry.input, null, 2)}</pre>
          <div className={vault.parkedActions}>
            <button
              type="button"
              className={vault.approveBtn}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                onConfirm(entry.invocationId, true);
              }}
            >
              Approve
            </button>
            <button
              type="button"
              className={vault.denyBtn}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                onConfirm(entry.invocationId, false);
              }}
            >
              Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function DemoSection({
  demo,
  onLoad,
  onPurge,
}: {
  demo: NonNullable<VaultData['demo']>;
  onLoad: () => void;
  onPurge: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <div className="cd-app-settings-section cd-vault-demo">
      <div className={vault.label}>Demo data</div>
      <Note>
        {demo.rows > 0
          ? `${demo.rows} demo row${demo.rows === 1 ? '' : 's'} loaded — safe to reset any time; real data is never touched.`
          : 'Load a sample scenario to try the app on realistic data. Demo rows are marked, never fire automations, and reset in one click.'}
      </Note>
      <div className={vault.demoActions}>
        {demo.seedable ? (
          <button
            type="button"
            className={vault.grantBtn}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onLoad();
            }}
          >
            Load demo data
          </button>
        ) : null}
        {demo.rows > 0 ? (
          <button
            type="button"
            className={vault.grantBtn}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onPurge();
            }}
          >
            Reset demo data
          </button>
        ) : null}
      </div>
    </div>
  );
}

type State =
  | { phase: 'loading' }
  | { phase: 'no-vault' }
  | { phase: 'error' }
  | { phase: 'ready'; data: VaultData };

/**
 * Vault — the per-app owner consent pane, ported to React (issue #325,
 * Phase 3). Unlike the read-only screens this one is stateful: it fetches the
 * consent surface through the vanilla-supplied `loadData`, and every owner act
 * (grant / revoke / confirm / demo) runs the matching gateway call, then
 * reloads. Emits the same `cd-vault-*` / `cd-app-settings-*` classes.
 */
export default function VaultScreen(props: VaultBridgeProps): JSX.Element {
  const { block, loadData, showToast, onAccessChanged, onParkedCount } = props;
  const [state, setState] = useState<State>({ phase: 'loading' });

  const reload = useCallback(async () => {
    try {
      const data = await loadData();
      if (!data) {
        setState({ phase: 'no-vault' });
        return;
      }
      onParkedCount?.(data.parked.length);
      setState({ data, phase: 'ready' });
    } catch {
      setState({ phase: 'error' });
    }
  }, [loadData, onParkedCount]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Run an owner action, then surface a toast, notify the shell, and reload.
  const act = useCallback(
    (run: () => Promise<void>, okMsg: string, failMsg: string) => {
      run()
        .then(() => {
          showToast?.(okMsg);
          onAccessChanged?.();
          return reload();
        })
        .catch((err: unknown) => {
          showToast?.(err instanceof Error ? err.message : failMsg);
          void reload();
        });
    },
    [showToast, onAccessChanged, reload],
  );

  if (state.phase === 'loading') {
    return (
      <>
        <RequestSection block={block} />
        <div className="cd-au-loading">Loading…</div>
      </>
    );
  }
  if (state.phase === 'no-vault') {
    return (
      <>
        <RequestSection block={block} />
        <Note>No vault is mounted on this gateway, so this app has nothing to project.</Note>
      </>
    );
  }
  if (state.phase === 'error') {
    return <Note>Could not read the vault consent surface.</Note>;
  }

  const { data } = state;
  const showDemo = data.demo && (data.demo.seedable || data.demo.rows > 0);
  return (
    <>
      <RequestSection block={block} />
      <GrantSection
        grants={data.grants}
        vaultName={data.vaultName}
        onGrant={() => act(props.grant, 'Vault access granted', 'Grant failed')}
        onRevoke={(id) => act(() => props.revoke(id), 'Vault access revoked', 'Revoke failed')}
      />
      {data.parked.length > 0 ? (
        <ParkedSection
          parked={data.parked}
          onConfirm={(id, approve) =>
            act(
              () => props.confirm(id, approve),
              approve ? 'Approved' : 'Denied',
              'Confirmation failed',
            )
          }
        />
      ) : null}
      {showDemo && data.demo ? (
        <DemoSection
          demo={data.demo}
          onLoad={() => act(props.demoLoad, 'Demo data loaded', 'Load demo data failed')}
          onPurge={() => act(props.demoPurge, 'Demo data reset', 'Reset demo data failed')}
        />
      ) : null}
    </>
  );
}
