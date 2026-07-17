// governance: allow-repo-hygiene file-size-limit single cohesive screen (connect form + recovery-kit gate + per-vault hosted/local toggle) — one storage-connection flow, same call SettingsConnectionsScreen.tsx makes
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Button, IconButton } from '../ui/index.js';
import { cx } from '../ui/cx.js';
import styles from './SettingsStorageScreen.module.css';
import drawerGroupCss from '../styles/drawerGroup.module.css';
import controlsCss from '../styles/controls.module.css';
import inlineEmptyCss from '../styles/inlineEmpty.module.css';
import modalCss from '../styles/modal.module.css';

// Settings → Storage (issue #436 §7): the owner surface collapsed to ONE
// choice per vault — "On this device" or "Hosted". There is a single
// connection model now, the managed provider "home" bundle (snapshots +
// attachments + previews, all one thing), so this screen has no connection-kind
// toggle, no "use for" checkboxes, no per-vault tier picker, and no BYO-S3
// form. It hosts: a guided "connect your storage provider" form, a real Test
// button, disconnect-with-confirm, the recovery-kit gate as a real blocking
// dialog (losing the seal key is the one mistake this screen can't let slide),
// and the per-vault hosted/local toggle. Gateway I/O + the recovery-kit-aware
// result shapes live in `routes/settingsStorageData.ts`.

export interface StorageConnectionRowDTO {
  id: string;
  name: string;
  baseUrl?: string;
}

/** The guided connect form (beta): a friendly name, the provider base URL, and
 *  a key. One kind only — every home is a managed provider bundle. */
export interface StorageConnectionFormInput {
  name: string;
  baseUrl: string;
  apiKey: string;
}

export type StorageMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'recovery_kit_not_confirmed'; message: string }
  | { ok: false; code: 'error'; message: string };

export type StorageTestResult = { ok: true; detail: string } | { ok: false; error: string };

export interface VaultBlobStoreDTO {
  kind: 'fs' | 's3';
  connectionId?: string;
}

export interface SettingsStorageBridgeProps {
  loadConnections: () => Promise<StorageConnectionRowDTO[]>;
  createConnection: (
    input: StorageConnectionFormInput,
    opts?: { force?: boolean },
  ) => Promise<StorageMutationResult<StorageConnectionRowDTO>>;
  deleteConnection: (id: string, name: string) => Promise<void>;
  testConnection: (id: string) => Promise<StorageTestResult>;
  /** POSTs the shared recovery-kit confirm endpoint. May itself fail (e.g.
   *  the gateway has no backup block configured, so there's nothing to
   *  confirm through it) — the gate dialog surfaces that inline rather than
   *  crashing, and "proceed anyway" stays available either way. */
  confirmRecoveryKit: () => Promise<{ confirmedAt: number }>;
  loadVaultBlobStore: () => Promise<VaultBlobStoreDTO>;
  attachVaultConnection: (
    connectionId: string,
    opts?: { force?: boolean },
  ) => Promise<StorageMutationResult<VaultBlobStoreDTO>>;
  detachVaultConnection: () => Promise<VaultBlobStoreDTO>;
  showToast: (message: string) => void;
}

/** A pending gated mutation — re-invoked by the dialog's two action paths. */
interface PendingGate {
  message: string;
  run: (opts?: { force?: boolean }) => Promise<void>;
}

function RecoveryKitGateDialog({
  gate,
  confirmRecoveryKit,
  onClose,
}: {
  gate: PendingGate;
  confirmRecoveryKit: () => Promise<{ confirmedAt: number }>;
  onClose: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState<'confirm' | 'force' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confirmAndRetry = async (): Promise<void> => {
    setBusy('confirm');
    setError(null);
    try {
      await confirmRecoveryKit();
      await gate.run();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const proceedAnyway = async (): Promise<void> => {
    setBusy('force');
    setError(null);
    try {
      await gate.run({ force: true });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={modalCss.backdrop}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className={modalCss.card} role="dialog" aria-label="Confirm your recovery kit">
        <IconButton icon="X" ariaLabel="Close" className={modalCss.close} onClick={onClose} />
        <h3>Before this ships bytes off this machine</h3>
        <p className={styles.gateReason}>{gate.message}</p>
        <p>
          Hosted storage is ciphertext without the seal key that made it — if it's ever lost,
          everything stored offsite becomes unrecoverable. Export the recovery kit once (
          <code>centraid-gateway backup kit</code>, or <code>key export</code>) and store it
          somewhere offline before continuing.
        </p>
        {error ? <div className={styles.gateError}>{error}</div> : null}
        <div className={modalCss.actions}>
          <Button
            variant="ghost"
            label={busy === 'force' ? 'Proceeding…' : 'Proceed anyway'}
            disabled={busy !== null}
            onClick={() => void proceedAnyway()}
            title="Skip the confirmation and continue anyway — only do this if you've already exported the kit through another gateway or CLI session."
          />
          <Button
            variant="primary"
            label={busy === 'confirm' ? 'Confirming…' : "I've saved my recovery kit"}
            disabled={busy !== null}
            onClick={() => void confirmAndRetry()}
          />
        </div>
      </div>
    </div>
  );
}

function ConnectionRow({
  row,
  busy,
  testResult,
  onTest,
  onDelete,
}: {
  row: StorageConnectionRowDTO;
  busy: boolean;
  testResult: 'testing' | StorageTestResult | undefined;
  onTest: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className={styles.row} data-testid="storage-connection-row">
      <div className={styles.rowMeta}>
        <div className={styles.rowHead}>
          <span className={styles.rowName}>{row.name}</span>
          <span className={styles.kindBadge} data-kind="provider">
            Hosted
          </span>
        </div>
        {row.baseUrl ? <span className={styles.rowSub}>{row.baseUrl}</span> : null}
        {testResult && testResult !== 'testing' ? (
          <span
            className={styles.testResult}
            data-ok={testResult.ok}
            data-testid="storage-test-result"
          >
            {testResult.ok ? testResult.detail : testResult.error}
          </span>
        ) : null}
      </div>
      <div className={styles.rowActions}>
        <Button
          variant="soft"
          size="sm"
          label={testResult === 'testing' ? 'Testing…' : 'Test connection'}
          disabled={busy || testResult === 'testing'}
          onClick={onTest}
        />
        <button
          type="button"
          className={cx(controlsCss.chip, controlsCss.chipDanger)}
          disabled={busy}
          onClick={onDelete}
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

function ConnectProviderForm({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: StorageConnectionFormInput) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');

  const ready = baseUrl.trim().length > 0 && apiKey.trim().length > 0;

  const submit = (): void => {
    if (!ready) return;
    onSubmit({
      name: name.trim() || 'Hosted storage',
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
    });
  };

  return (
    <div className={styles.wizard}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name (optional)</span>
        <input
          className={styles.textInput}
          placeholder="Hosted storage"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Provider URL</span>
        <input
          className={styles.textInput}
          placeholder="https://storage.example.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Access key</span>
        <input
          className={styles.textInput}
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>

      {error ? (
        <div className={styles.gateError} data-testid="connect-error">
          {error}
        </div>
      ) : null}

      <div className={styles.wizardFoot}>
        <Button variant="ghost" size="sm" label="Cancel" onClick={onCancel} />
        <Button
          variant="primary"
          size="sm"
          label={busy ? 'Connecting…' : 'Connect'}
          disabled={!ready || busy}
          onClick={submit}
        />
      </div>
    </div>
  );
}

/** The one binary this whole screen exists to set: is this vault's data kept
 *  only on this device, or an encrypted copy hosted with your provider? */
function VaultStorageChoice({
  homeConnectionId,
  blobStore,
  busy,
  onAttach,
  onDetach,
}: {
  homeConnectionId: string | undefined;
  blobStore: VaultBlobStoreDTO | null;
  busy: boolean;
  onAttach: (connectionId: string) => void;
  onDetach: () => void;
}): JSX.Element {
  if (blobStore === null) {
    return <div className={controlsCss.note}>Reading this vault's storage settings…</div>;
  }
  const hosted = blobStore.kind === 's3';
  const hostedDisabled = !homeConnectionId || busy;

  const chooseDevice = (): void => {
    if (hosted && !busy) onDetach();
  };
  const chooseHosted = (): void => {
    if (!hosted && homeConnectionId && !busy) onAttach(homeConnectionId);
  };

  return (
    <div className={styles.attachRow}>
      <div
        className={styles.binaryToggle}
        role="radiogroup"
        aria-label="Where this vault is stored"
      >
        <button
          type="button"
          role="radio"
          aria-checked={!hosted}
          className={styles.binaryOption}
          data-active={String(!hosted)}
          disabled={busy}
          onClick={chooseDevice}
        >
          On this device
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={hosted}
          className={styles.binaryOption}
          data-active={String(hosted)}
          disabled={hostedDisabled}
          onClick={chooseHosted}
        >
          Hosted
        </button>
      </div>
      <p className={styles.attachStatus}>
        {hosted
          ? 'Snapshots, attachments, and previews are kept as one sealed bundle with your provider.'
          : homeConnectionId
            ? 'Everything stays on this machine. Switch to Hosted to keep an encrypted offsite copy.'
            : 'Everything stays on this machine. Connect a storage provider above to turn on hosted storage.'}
      </p>
    </div>
  );
}

export default function SettingsStorageScreen({
  loadConnections,
  createConnection,
  deleteConnection,
  testConnection,
  confirmRecoveryKit,
  loadVaultBlobStore,
  attachVaultConnection,
  detachVaultConnection,
  showToast,
}: SettingsStorageBridgeProps): JSX.Element {
  const [rows, setRows] = useState<StorageConnectionRowDTO[] | null>(null);
  const [blobStore, setBlobStore] = useState<VaultBlobStoreDTO | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [attachBusy, setAttachBusy] = useState(false);
  const [testResults, setTestResults] = useState<Map<string, 'testing' | StorageTestResult>>(
    new Map(),
  );
  const [gate, setGate] = useState<PendingGate | null>(null);
  const mountedRef = useRef(true);

  const refresh = useMemo(
    () => (): void => {
      void loadConnections()
        .then(setRows)
        .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)));
      void loadVaultBlobStore()
        .then(setBlobStore)
        .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#436) mirrors SettingsConnectionsScreen: track loader identities only
    [loadConnections, loadVaultBlobStore],
  );

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#436) mount-once refresh keyed to loader identities, not refresh's own identity
  }, [loadConnections, loadVaultBlobStore]);

  const withBusy = (id: string, fn: () => Promise<void>): void => {
    setBusyIds((s) => new Set(s).add(id));
    void fn()
      .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setBusyIds((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
        refresh();
      });
  };

  const runCreate = async (
    input: StorageConnectionFormInput,
    opts?: { force?: boolean },
  ): Promise<void> => {
    const result = await createConnection(input, opts);
    if (result.ok) {
      setWizardOpen(false);
      setFormError(null);
      refresh();
      return;
    }
    if (result.code === 'recovery_kit_not_confirmed') {
      setGate({ message: result.message, run: (o) => runCreate(input, o) });
      return;
    }
    throw new Error(result.message);
  };

  const onSubmitWizard = (input: StorageConnectionFormInput): void => {
    setSaving(true);
    setFormError(null);
    runCreate(input)
      .catch((err: unknown) => setFormError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  const onTest = (id: string): void => {
    setTestResults((m) => new Map(m).set(id, 'testing'));
    void testConnection(id)
      .then((result) => setTestResults((m) => new Map(m).set(id, result)))
      .catch((err: unknown) =>
        setTestResults((m) =>
          new Map(m).set(id, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      );
  };

  const onDelete = (row: StorageConnectionRowDTO): void => {
    withBusy(row.id, () => deleteConnection(row.id, row.name));
  };

  const runAttach = async (connectionId: string, opts?: { force?: boolean }): Promise<void> => {
    const result = await attachVaultConnection(connectionId, opts);
    if (result.ok) {
      if (mountedRef.current) setBlobStore(result.value);
      return;
    }
    if (result.code === 'recovery_kit_not_confirmed') {
      setGate({ message: result.message, run: (o) => runAttach(connectionId, o) });
      return;
    }
    throw new Error(result.message);
  };

  const onAttach = (connectionId: string): void => {
    setAttachBusy(true);
    runAttach(connectionId)
      .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)))
      .finally(() => setAttachBusy(false));
  };

  const onDetach = (): void => {
    setAttachBusy(true);
    void (async () => {
      try {
        const next = await detachVaultConnection();
        if (mountedRef.current) setBlobStore(next);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      } finally {
        setAttachBusy(false);
      }
    })();
  };

  const homeConnectionId = rows?.[0]?.id;

  return (
    <div className={drawerGroupCss.group}>
      <div className={drawerGroupCss.groupLabel}>Hosted storage</div>
      <div className={drawerGroupCss.groupBody}>
        <div className={controlsCss.note}>
          Keep an encrypted copy of this profile with a storage provider — snapshots, attachments,
          and previews, all sealed on your device before they leave it. The provider only ever sees
          ciphertext.
        </div>

        {rows === null ? (
          <div className={controlsCss.note}>Reading storage…</div>
        ) : rows.length === 0 ? (
          wizardOpen ? (
            <ConnectProviderForm
              busy={saving}
              error={formError}
              onCancel={() => {
                setWizardOpen(false);
                setFormError(null);
              }}
              onSubmit={onSubmitWizard}
            />
          ) : (
            <>
              <div className={inlineEmptyCss.inlineEmpty}>No storage provider connected yet.</div>
              <Button
                variant="soft"
                size="sm"
                icon="Plus"
                label="Connect your storage provider"
                onClick={() => setWizardOpen(true)}
              />
            </>
          )
        ) : (
          <div className={styles.panel}>
            {rows.map((row) => (
              <ConnectionRow
                key={row.id}
                row={row}
                busy={busyIds.has(row.id)}
                testResult={testResults.get(row.id)}
                onTest={() => onTest(row.id)}
                onDelete={() => onDelete(row)}
              />
            ))}
          </div>
        )}
      </div>

      <div className={drawerGroupCss.groupLabel}>This vault</div>
      <div className={drawerGroupCss.groupBody}>
        <VaultStorageChoice
          homeConnectionId={homeConnectionId}
          blobStore={blobStore}
          busy={attachBusy}
          onAttach={onAttach}
          onDetach={onDetach}
        />
      </div>

      {gate ? (
        <RecoveryKitGateDialog
          gate={gate}
          confirmRecoveryKit={confirmRecoveryKit}
          onClose={() => setGate(null)}
        />
      ) : null}
    </div>
  );
}
