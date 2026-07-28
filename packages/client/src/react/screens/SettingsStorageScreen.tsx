// governance: allow-repo-hygiene file-size-limit single cohesive screen (connect form + recovery-kit gate + per-vault hosted/local toggle) — one storage-connection flow, same call SettingsConnectionsScreen.tsx makes
import { useCallback, useEffect, useRef, useState, type JSX } from "react";

import { cx } from "../ui/cx.js";
import { Button, IconButton } from "../ui/index.js";

import a11y from "../styles/a11y.module.css";
import controlsCss from "../styles/controls.module.css";
import drawerGroupCss from "../styles/drawerGroup.module.css";
import inlineEmptyCss from "../styles/inlineEmpty.module.css";
import modalCss from "../styles/modal.module.css";
import styles from "./SettingsStorageScreen.module.css";

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
  | { ok: false; code: "recovery_kit_not_confirmed"; message: string }
  | { ok: false; code: "error"; message: string };

export type StorageTestResult =
  | { ok: true; detail: string }
  | { ok: false; error: string };

export interface VaultBlobStoreDTO {
  kind: "fs" | "s3";
  connectionId?: string;
}

export interface SettingsStorageBridgeProps {
  loadConnections: () => Promise<StorageConnectionRowDTO[]>;
  createConnection: (
    input: StorageConnectionFormInput
  ) => Promise<StorageMutationResult<StorageConnectionRowDTO>>;
  deleteConnection: (id: string, name: string) => Promise<void>;
  testConnection: (id: string) => Promise<StorageTestResult>;
  loadVaultBlobStore: () => Promise<VaultBlobStoreDTO>;
  attachVaultConnection: (
    connectionId: string
  ) => Promise<StorageMutationResult<VaultBlobStoreDTO>>;
  detachVaultConnection: () => Promise<VaultBlobStoreDTO>;
  showToast: (message: string) => void;
}

interface PendingGate {
  message: string;
}

function RecoveryKitGateDialog({
  gate,
  onClose,
}: {
  gate: PendingGate;
  onClose: () => void;
}): JSX.Element {
  return (
    <div
      className={modalCss.backdrop}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <dialog
        open
        className={modalCss.card}
        aria-label="Confirm your recovery kit"
      >
        <IconButton
          icon="X"
          ariaLabel="Close"
          className={modalCss.close}
          onClick={onClose}
        />
        <h3>Before this ships bytes off this machine</h3>
        <p className={styles.gateReason}>{gate.message}</p>
        <p>
          Hosted storage is ciphertext without the seal key that made it — if
          it's ever lost, the backed-up vaults stored offsite become
          unrecoverable. Local-only vaults are not included. Open the Storage
          page, export a password-wrapped recovery kit, re-select that exact
          file, and complete the loss-consent check before continuing.
        </p>
        <div className={modalCss.actions}>
          <Button variant="primary" label="Close" onClick={onClose} />
        </div>
      </dialog>
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
  testResult: "testing" | StorageTestResult | undefined;
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
        {row.baseUrl ? (
          <span className={styles.rowSub}>{row.baseUrl}</span>
        ) : null}
        {testResult && testResult !== "testing" ? (
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
          label={testResult === "testing" ? "Testing…" : "Test connection"}
          disabled={busy || testResult === "testing"}
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
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  const ready = baseUrl.trim().length > 0 && apiKey.trim().length > 0;

  const submit = (): void => {
    if (!ready) return;
    onSubmit({
      name: name.trim() || "Hosted storage",
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
          label={busy ? "Connecting…" : "Connect"}
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
    return (
      <div className={controlsCss.note}>
        Reading this vault's storage settings…
      </div>
    );
  }
  const hosted = blobStore.kind === "s3";
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
        <label className={styles.binaryOption} data-active={String(!hosted)}>
          <input
            type="radio"
            className={a11y.srControl}
            name="vault-storage-location"
            checked={!hosted}
            disabled={busy}
            onChange={chooseDevice}
          />
          On this device
        </label>
        <label className={styles.binaryOption} data-active={String(hosted)}>
          <input
            type="radio"
            className={a11y.srControl}
            name="vault-storage-location"
            checked={hosted}
            disabled={hostedDisabled}
            onChange={chooseHosted}
          />
          Hosted
        </label>
      </div>
      <p className={styles.attachStatus}>
        {hosted
          ? "Snapshots, attachments, and previews are kept as one sealed bundle with your provider."
          : homeConnectionId
            ? "Everything stays on this machine. Switch to Hosted to keep an encrypted offsite copy."
            : "Everything stays on this machine. Connect a storage provider above to turn on hosted storage."}
      </p>
    </div>
  );
}

export default function SettingsStorageScreen({
  loadConnections,
  createConnection,
  deleteConnection,
  testConnection,
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
  const [testResults, setTestResults] = useState<
    Map<string, "testing" | StorageTestResult>
  >(new Map());
  const [gate, setGate] = useState<PendingGate | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback((): void => {
    void loadConnections()
      .then(setRows)
      .catch((err: unknown) =>
        showToast(err instanceof Error ? err.message : String(err))
      );
    void loadVaultBlobStore()
      .then(setBlobStore)
      .catch((err: unknown) =>
        showToast(err instanceof Error ? err.message : String(err))
      );
  }, [loadConnections, loadVaultBlobStore, showToast]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [loadConnections, loadVaultBlobStore, refresh]);

  const withBusy = (id: string, fn: () => Promise<void>): void => {
    setBusyIds((s) => new Set(s).add(id));
    void fn()
      .catch((err: unknown) =>
        showToast(err instanceof Error ? err.message : String(err))
      )
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
    input: StorageConnectionFormInput
  ): Promise<void> => {
    const result = await createConnection(input);
    if (result.ok) {
      setWizardOpen(false);
      setFormError(null);
      refresh();
      return;
    }
    if (result.code === "recovery_kit_not_confirmed") {
      setGate({ message: result.message });
      return;
    }
    throw new Error(result.message);
  };

  const onSubmitWizard = (input: StorageConnectionFormInput): void => {
    setSaving(true);
    setFormError(null);
    runCreate(input)
      .catch((err: unknown) =>
        setFormError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setSaving(false));
  };

  const onTest = (id: string): void => {
    setTestResults((m) => new Map(m).set(id, "testing"));
    void testConnection(id)
      .then((result) => setTestResults((m) => new Map(m).set(id, result)))
      .catch((err: unknown) =>
        setTestResults((m) =>
          new Map(m).set(id, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        )
      );
  };

  const onDelete = (row: StorageConnectionRowDTO): void => {
    withBusy(row.id, () => deleteConnection(row.id, row.name));
  };

  const runAttach = async (connectionId: string): Promise<void> => {
    const result = await attachVaultConnection(connectionId);
    if (result.ok) {
      if (mountedRef.current) setBlobStore(result.value);
      return;
    }
    if (result.code === "recovery_kit_not_confirmed") {
      setGate({ message: result.message });
      return;
    }
    throw new Error(result.message);
  };

  const onAttach = (connectionId: string): void => {
    setAttachBusy(true);
    runAttach(connectionId)
      .catch((err: unknown) =>
        showToast(err instanceof Error ? err.message : String(err))
      )
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
          Keep an encrypted copy of this profile with a storage provider —
          snapshots, attachments, and previews, all sealed on your device before
          they leave it. The provider only ever sees ciphertext.
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
              <div className={inlineEmptyCss.inlineEmpty}>
                No storage provider connected yet.
              </div>
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
        <RecoveryKitGateDialog gate={gate} onClose={() => setGate(null)} />
      ) : null}
    </div>
  );
}
