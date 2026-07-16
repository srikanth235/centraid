// governance: allow-repo-hygiene file-size-limit single cohesive screen (list + add wizard + recovery-kit gate + per-vault attach) — splitting would fragment one storage-connection flow, same call SettingsConnectionsScreen.tsx makes
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Button, IconButton } from '../ui/index.js';
import { cx } from '../ui/cx.js';
import styles from './SettingsStorageScreen.module.css';
import drawerGroupCss from '../styles/drawerGroup.module.css';
import controlsCss from '../styles/controls.module.css';
import inlineEmptyCss from '../styles/inlineEmpty.module.css';
import selectCss from '../styles/select.module.css';
import modalCss from '../styles/modal.module.css';

// Settings → Storage (issue #367 §D4): the owner surface over the
// gateway-level storage-connection entity (Section C's storage-routes.ts) —
// shared by offsite backup snapshots and a vault's CAS remote tier. Lists
// every connection (never a secret field — the gateway never puts one on
// the wire), an inline add-connection form for both kinds, a real Test
// button, delete-with-confirm, the recovery-kit gate as a real blocking
// dialog (not a toast — losing track of a seal key is the one mistake this
// screen can't let slide by), and a compact per-vault "which connection is
// this vault's CAS tier attached to" section.
//
// Kept prop-driven like SettingsConnectionsScreen: this file owns view +
// interaction state only. Gateway I/O + the recovery-kit-aware result
// shapes live in `routes/settingsStorageData.ts`.

export type StorageConnectionKind = 'byo-s3' | 'provider';
export type StorageConnectionUse = 'backup' | 'cas';

export interface StorageConnectionRowDTO {
  id: string;
  kind: StorageConnectionKind;
  name: string;
  uses: StorageConnectionUse[];
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  baseUrl?: string;
}

export type StorageConnectionFormInput =
  | {
      kind: 'byo-s3';
      name: string;
      endpoint: string;
      region: string;
      bucket: string;
      prefix?: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
      uses: StorageConnectionUse[];
    }
  | {
      kind: 'provider';
      name: string;
      baseUrl: string;
      apiKey: string;
      uses: StorageConnectionUse[];
    };

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

const KIND_LABEL: Record<StorageConnectionKind, string> = {
  'byo-s3': 'BYO S3',
  provider: 'Provider',
};
const USE_LABEL: Record<StorageConnectionUse, string> = { backup: 'Backup', cas: 'CAS' };

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
          A remote storage tier is ciphertext without the seal key that made it — if it's ever lost,
          everything replicated through it becomes unrecoverable. Export the recovery kit once (
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
          <span className={styles.kindBadge} data-kind={row.kind}>
            {KIND_LABEL[row.kind]}
          </span>
          {row.uses.map((u) => (
            <span key={u} className={styles.useBadge}>
              {USE_LABEL[u]}
            </span>
          ))}
        </div>
        <span className={styles.rowSub}>
          {row.kind === 'byo-s3'
            ? `${row.endpoint ?? ''} · ${row.bucket ?? ''}${row.prefix ? ` · ${row.prefix}` : ''}`
            : row.baseUrl}
        </span>
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
          Delete
        </button>
      </div>
    </div>
  );
}

function AddConnectionForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: StorageConnectionFormInput) => void;
}): JSX.Element {
  const [kind, setKind] = useState<StorageConnectionKind>('byo-s3');
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('');
  const [bucket, setBucket] = useState('');
  const [prefix, setPrefix] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [usesBackup, setUsesBackup] = useState(true);
  const [usesCas, setUsesCas] = useState(true);

  const uses: StorageConnectionUse[] = [
    ...(kind === 'provider' && usesBackup ? (['backup'] as const) : []),
    ...(usesCas ? (['cas'] as const) : []),
  ];

  const ready =
    name.trim().length > 0 &&
    uses.length > 0 &&
    (kind === 'byo-s3'
      ? endpoint.trim().length > 0 &&
        region.trim().length > 0 &&
        bucket.trim().length > 0 &&
        accessKeyId.trim().length > 0 &&
        secretAccessKey.trim().length > 0
      : baseUrl.trim().length > 0 && apiKey.trim().length > 0);

  const submit = (): void => {
    if (!ready) return;
    if (kind === 'byo-s3') {
      onSubmit({
        kind: 'byo-s3',
        name: name.trim(),
        endpoint: endpoint.trim(),
        region: region.trim(),
        bucket: bucket.trim(),
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        uses,
      });
    } else {
      onSubmit({
        kind: 'provider',
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        uses,
      });
    }
  };

  return (
    <div className={styles.wizard}>
      <div className={styles.kindToggle} role="radiogroup" aria-label="Connection kind">
        <button
          type="button"
          className={styles.kindOption}
          data-active={String(kind === 'byo-s3')}
          onClick={() => setKind('byo-s3')}
        >
          Bring your own S3
        </button>
        <button
          type="button"
          className={styles.kindOption}
          data-active={String(kind === 'provider')}
          onClick={() => setKind('provider')}
        >
          Storage provider
        </button>
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name</span>
        <input
          className={styles.textInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      {kind === 'byo-s3' ? (
        <>
          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Endpoint</span>
              <input
                className={styles.textInput}
                placeholder="https://s3.example.com"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Region</span>
              <input
                className={styles.textInput}
                placeholder="auto"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              />
            </label>
          </div>
          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Bucket</span>
              <input
                className={styles.textInput}
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Prefix (optional)</span>
              <input
                className={styles.textInput}
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
              />
            </label>
          </div>
          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Access key ID</span>
              <input
                className={styles.textInput}
                autoComplete="off"
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Secret access key</span>
              <input
                className={styles.textInput}
                type="password"
                autoComplete="off"
                value={secretAccessKey}
                onChange={(e) => setSecretAccessKey(e.target.value)}
              />
            </label>
          </div>
        </>
      ) : (
        <div className={styles.fieldRow}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Base URL</span>
            <input
              className={styles.textInput}
              placeholder="https://api.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>API key</span>
            <input
              className={styles.textInput}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
        </div>
      )}

      <div className={styles.usesRow}>
        <span className={styles.fieldLabel}>Use for</span>
        {kind === 'provider' ? (
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={usesBackup}
              onChange={(e) => setUsesBackup(e.target.checked)}
            />
            Encrypted backup snapshots
          </label>
        ) : (
          <span className={controlsCss.note}>
            Direct S3 is for blob replication. Recoverable snapshots require a storage provider with
            retention and takeover protection.
          </span>
        )}
        <label className={styles.checkLabel}>
          <input type="checkbox" checked={usesCas} onChange={(e) => setUsesCas(e.target.checked)} />
          CAS blob replication
        </label>
      </div>

      <div className={styles.wizardFoot}>
        <Button variant="ghost" size="sm" label="Cancel" onClick={onCancel} />
        <Button
          variant="primary"
          size="sm"
          label={busy ? 'Saving…' : 'Add connection'}
          disabled={!ready || busy}
          onClick={submit}
        />
      </div>
    </div>
  );
}

function VaultAttachSection({
  connections,
  blobStore,
  busy,
  onAttach,
  onDetach,
}: {
  connections: StorageConnectionRowDTO[];
  blobStore: VaultBlobStoreDTO | null;
  busy: boolean;
  onAttach: (connectionId: string) => void;
  onDetach: () => void;
}): JSX.Element {
  const casConnections = connections.filter((c) => c.uses.includes('cas'));
  const [selected, setSelected] = useState(casConnections[0]?.id ?? '');

  useEffect(() => {
    if (!casConnections.some((c) => c.id === selected)) {
      setSelected(casConnections[0]?.id ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#367) re-seed only when the CAS-capable set changes
  }, [casConnections.map((c) => c.id).join(',')]);

  if (casConnections.length === 0) {
    return (
      <div className={controlsCss.note}>
        Add a connection above with “CAS blob replication” enabled to give this vault a remote CAS
        tier.
      </div>
    );
  }

  const attached =
    blobStore?.kind === 's3' ? connections.find((c) => c.id === blobStore.connectionId) : undefined;

  return (
    <div className={styles.attachRow}>
      <div className={styles.attachStatus}>
        {blobStore === null ? (
          <span className={controlsCss.note}>Reading this vault's storage settings…</span>
        ) : blobStore.kind === 's3' ? (
          <span>
            This vault's blobs replicate through{' '}
            <strong>{attached?.name ?? blobStore.connectionId}</strong>.
          </span>
        ) : (
          <span>This vault stores blobs locally only — no remote CAS tier attached.</span>
        )}
      </div>
      <div className={styles.attachControls}>
        <span className={selectCss.selectWrap}>
          <select
            className={selectCss.select}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy}
          >
            {casConnections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </span>
        <Button
          variant="soft"
          size="sm"
          label="Attach"
          disabled={busy || !selected}
          onClick={() => onAttach(selected)}
        />
        {blobStore?.kind === 's3' ? (
          <button type="button" className={controlsCss.chip} disabled={busy} onClick={onDetach}>
            Detach
          </button>
        ) : null}
      </div>
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#367) mirrors SettingsConnectionsScreen: track loader identities only
    [loadConnections, loadVaultBlobStore],
  );

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#367) mount-once refresh keyed to loader identities, not refresh's own identity
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
    runCreate(input)
      .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)))
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

  return (
    <div className={drawerGroupCss.group}>
      <div className={drawerGroupCss.groupLabel}>Storage connections</div>
      <div className={drawerGroupCss.groupBody}>
        <div className={controlsCss.note}>
          Where offsite backup snapshots and replicated blobs go. Connections never carry a saved
          secret back to this screen — credentials are sealed on the gateway host.
        </div>

        <div className={styles.panel}>
          {rows === null ? (
            <div className={controlsCss.note}>Reading connections…</div>
          ) : rows.length === 0 ? (
            <div className={inlineEmptyCss.inlineEmpty}>No storage connections configured yet.</div>
          ) : (
            rows.map((row) => (
              <ConnectionRow
                key={row.id}
                row={row}
                busy={busyIds.has(row.id)}
                testResult={testResults.get(row.id)}
                onTest={() => onTest(row.id)}
                onDelete={() => onDelete(row)}
              />
            ))
          )}
        </div>

        {wizardOpen ? (
          <AddConnectionForm
            busy={saving}
            onCancel={() => setWizardOpen(false)}
            onSubmit={onSubmitWizard}
          />
        ) : (
          <Button
            variant="soft"
            size="sm"
            icon="Plus"
            label="Add connection"
            onClick={() => setWizardOpen(true)}
          />
        )}
      </div>

      <div className={drawerGroupCss.groupLabel}>This vault's CAS tier</div>
      <div className={drawerGroupCss.groupBody}>
        <VaultAttachSection
          connections={rows ?? []}
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
