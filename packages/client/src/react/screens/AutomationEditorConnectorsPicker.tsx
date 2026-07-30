import { useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  AuEditorCatalogConnectorDTO,
  AuEditorConnectFormInput,
} from "../screen-contracts.js";
import { cx } from "../ui/cx.js";
import { Button, Icon } from "../ui/index.js";
import { ConnectorBrandGlyph } from "./connectorBrandMarks.js";
import type { ConnectorTone } from "./connectorBrandMarks.js";

import styles from "./AutomationEditorScreen.module.css";

const HEALTH_LABEL: Record<
  NonNullable<AuEditorCatalogConnectorDTO["connection"]>["health"],
  string
> = {
  failing: "Failing",
  "needs-auth": "Needs auth",
  ok: "Connected",
  paused: "Paused",
};

function ConnectInlineForm({
  item,
  busy,
  onCancel,
  onSubmit,
}: {
  item: AuEditorCatalogConnectorDTO;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: AuEditorConnectFormInput) => void;
}): JSX.Element {
  const [label, setLabel] = useState(
    () =>
      `${item.providerName.split(" (")[0] ?? item.providerName} · ${item.name}`
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);

  const ready =
    label.trim().length > 0 &&
    (item.credKind === "oauth2"
      ? clientId.trim().length > 0 && clientSecret.trim().length > 0
      : apiKey.trim().length > 0);

  return (
    <div className={styles.connForm}>
      <p className={styles.connFormLead}>
        {item.credKind === "oauth2"
          ? "OAuth — register your own client (BYO), then authorize in the browser."
          : "API key / personal token for this service."}
      </p>
      <label className={styles.connField}>
        <span className={styles.microLabel}>Label</span>
        <input
          className={styles.input}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          autoComplete="off"
          data-testid="connector-label-input"
        />
        <span className={styles.connFieldHint}>
          Names this connection. Use a distinct label per account (e.g. “
          {item.name} · work”) to connect more than one.
        </span>
      </label>
      {item.credKind === "oauth2" ? (
        <>
          <label className={styles.connField}>
            <span className={styles.microLabel}>Client ID</span>
            <input
              className={styles.input}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className={styles.connField}>
            <span className={styles.microLabel}>Client secret</span>
            <input
              className={styles.input}
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              autoComplete="off"
            />
          </label>
        </>
      ) : (
        <label className={styles.connField}>
          <span className={styles.microLabel}>API key / token</span>
          <input
            className={styles.input}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </label>
      )}
      {item.setup.length > 0 ? (
        <div>
          <button
            type="button"
            className={styles.connGuideToggle}
            onClick={() => setGuideOpen((o) => !o)}
          >
            {guideOpen ? "Hide setup guide" : "Show setup guide"}
          </button>
          {guideOpen ? (
            <ol className={styles.connGuideList}>
              {item.setup.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
      <div className={styles.connFormActions}>
        <Button variant="ghost" size="sm" label="Cancel" onClick={onCancel} />
        <Button
          variant="primary"
          size="sm"
          label={
            busy
              ? "Saving…"
              : item.credKind === "oauth2"
                ? "Save & authorize"
                : "Save"
          }
          disabled={!ready || busy}
          onClick={() => {
            if (!ready) return;
            onSubmit({
              allowedHosts: item.allowedHosts,
              apiKey: item.credKind === "api_key" ? apiKey.trim() : undefined,
              authUrl: item.authUrl,
              clientId:
                item.credKind === "oauth2" ? clientId.trim() : undefined,
              clientSecret:
                item.credKind === "oauth2" ? clientSecret.trim() : undefined,
              connectorKind: item.kind,
              credKind: item.credKind,
              label: label.trim(),
              providerId: item.providerId,
              scopes: item.scope ?? item.scopes,
              tokenUrl: item.tokenUrl,
            });
          }}
        />
      </div>
    </div>
  );
}

export function AutomationEditorConnectorsPicker({
  open,
  catalog,
  loading,
  selected,
  bindings,
  onToggleSelect,
  onBoundConnection,
  onClose,
  configureConnection,
  beginAuthorize,
  onConnected,
  showToast,
}: {
  open: boolean;
  catalog: AuEditorCatalogConnectorDTO[];
  loading: boolean;
  selected: ReadonlySet<string>;
  bindings: ReadonlyMap<
    string,
    { connectionId: string; kind: string; label: string }
  >;
  onToggleSelect: (kind: string, connectionId?: string) => void;
  /**
   * After a successful configure/authorize — persists durable vault
   * connection id on the editor form so save includes the binding.
   */
  onBoundConnection: (binding: {
    connectionId: string;
    kind: string;
    label: string;
  }) => void;
  onClose: () => void;
  configureConnection?: (
    input: AuEditorConnectFormInput
  ) => Promise<{ connectionId: string } | void>;
  beginAuthorize?: (connectionId: string) => Promise<string>;
  onConnected: () => void;
  showToast?: (message: string) => void;
}): JSX.Element | null {
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [connectingKind, setConnectingKind] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // Closing discards the sheet's transient state. Done during render (the React
  // "adjust state when a prop changes" pattern) so a reopen never flashes the
  // previous filter.
  const [seenOpen, setSeenOpen] = useState(open);
  if (seenOpen !== open) {
    setSeenOpen(open);
    if (!open) {
      setConnectingKind(null);
      setFilter("");
    }
  }

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  const q = filter.trim().toLowerCase();
  const rows = q
    ? catalog.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.kind.toLowerCase().includes(q) ||
          c.providerName.toLowerCase().includes(q)
      )
    : catalog;

  const runConfigure = async (
    item: AuEditorCatalogConnectorDTO,
    input: AuEditorConnectFormInput
  ) => {
    if (!configureConnection) {
      showToast?.("Connecting is not available in this host.");
      return;
    }
    setBusyKind(item.kind);
    try {
      const result = await configureConnection(input);
      const connectionId =
        result && "connectionId" in result ? result.connectionId : undefined;
      if (item.credKind === "oauth2" && beginAuthorize && connectionId) {
        const url = await beginAuthorize(connectionId);
        window.open(url, "_blank", "noopener,noreferrer");
        showToast?.(
          `${item.name} saved — finish authorization in the browser.`
        );
      } else {
        showToast?.(`${item.name} connected`);
      }
      setConnectingKind(null);
      // Durable bind first so save includes connectionId even before catalog refresh.
      if (connectionId) {
        onBoundConnection({
          connectionId,
          kind: item.kind,
          label: input.label.trim() || item.name,
        });
      } else if (!selected.has(item.kind)) {
        onToggleSelect(item.kind);
      }
      onConnected();
    } catch (error) {
      showToast?.(
        `Could not connect: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBusyKind(null);
    }
  };

  const runAuthorize = async (item: AuEditorCatalogConnectorDTO) => {
    const id = item.connection?.connectionId;
    if (!id || !beginAuthorize) return;
    setBusyKind(item.kind);
    try {
      const url = await beginAuthorize(id);
      window.open(url, "_blank", "noopener,noreferrer");
      showToast?.("Complete authorization in the browser window.");
      onBoundConnection({
        connectionId: id,
        kind: item.kind,
        label: item.connection?.label ?? item.name,
      });
      onConnected();
    } catch (error) {
      showToast?.(
        `Authorize failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBusyKind(null);
    }
  };

  return (
    <dialog
      open
      className={styles.connPicker}
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="automation-connectors-picker"
    >
      <div className={styles.connPickerHead}>
        <div>
          <div id={titleId} className={styles.connPickerTitle}>
            Connectors
          </div>
          <p className={styles.connPickerHint}>
            Pick services this automation may use. OAuth and API-key connectors
            use the same credential flow as Settings → Connectors.
          </p>
        </div>
        <button
          type="button"
          className={styles.connPickerClose}
          onClick={onClose}
          aria-label="Close"
        >
          <Icon name="X" size={14} />
        </button>
      </div>
      <input
        ref={searchRef}
        className={cx(styles.input, styles.connPickerSearch)}
        type="search"
        placeholder="Search connectors…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        aria-label="Search connectors"
      />
      <div className={styles.connPickerList}>
        {loading ? (
          <p className={styles.connPickerEmpty}>Loading connectors…</p>
        ) : rows.length === 0 ? (
          <p className={styles.connPickerEmpty}>
            {catalog.length === 0
              ? "No connector catalog available. Open Connectors in the sidebar to add providers."
              : "No matches."}
          </p>
        ) : (
          rows.map((item) => {
            const isSelected = selected.has(item.kind);
            const health = item.connection?.health;
            const boundConnectionId = bindings.get(item.kind)?.connectionId;
            // The saved binding points at a connection the vault no longer
            // lists — the owner revoked that account. Never resolved silently
            // (that would swap the principal the automation acts as): the row
            // says so and opens the account list so a replacement is a
            // deliberate choice (#541).
            const bindingDangling =
              boundConnectionId !== undefined &&
              !item.connections.some(
                (c) => c.connectionId === boundConnectionId
              );
            const multipleAccounts = item.connections.length > 1;
            const hasAccountChoice = multipleAccounts || bindingDangling;
            const connecting = connectingKind === item.kind;
            const busy = busyKind === item.kind;
            return (
              <div
                key={item.key}
                className={styles.connPickerRow}
                data-selected={String(isSelected)}
                data-kind={item.kind}
              >
                <button
                  type="button"
                  className={styles.connPickerMain}
                  onClick={() => {
                    if (!hasAccountChoice || isSelected) {
                      onToggleSelect(item.kind, item.connection?.connectionId);
                    }
                  }}
                  aria-pressed={isSelected}
                >
                  <span className={styles.connPickerMark} aria-hidden="true">
                    <ConnectorBrandGlyph
                      tone={(item.tone as ConnectorTone) || "default"}
                      size={22}
                    />
                  </span>
                  <span className={styles.connPickerMeta}>
                    <span className={styles.connPickerName}>{item.name}</span>
                    <span className={styles.connPickerSub}>
                      {item.credKind === "oauth2" ? "OAuth" : "API key"}
                      {multipleAccounts
                        ? ` · ${item.connections.length} configured accounts`
                        : bindingDangling
                          ? " · Bound account unavailable"
                          : health
                            ? ` · ${HEALTH_LABEL[health]} · ${item.connection?.label}`
                            : " · Not connected"}
                    </span>
                  </span>
                  <span
                    className={styles.connPickerCheck}
                    data-on={String(isSelected)}
                    aria-hidden="true"
                  >
                    {isSelected ? <Icon name="Check" size={14} /> : null}
                  </span>
                </button>
                {hasAccountChoice ? (
                  <fieldset
                    className={styles.connAccountList}
                    aria-label={`Choose ${item.name} account`}
                  >
                    {bindingDangling ? (
                      <p
                        className={styles.connAccountWarn}
                        data-testid="connector-account-dangling"
                        data-kind={item.kind}
                      >
                        This automation is still bound to an account that is no
                        longer configured. Nothing was changed for you — pick a
                        replacement.
                      </p>
                    ) : null}
                    {item.connections.map((connection) => {
                      const chosen =
                        boundConnectionId === connection.connectionId;
                      return (
                        <button
                          key={connection.connectionId}
                          type="button"
                          className={styles.connAccount}
                          data-chosen={String(chosen)}
                          data-connection-id={connection.connectionId}
                          onClick={() =>
                            onBoundConnection({
                              connectionId: connection.connectionId,
                              kind: item.kind,
                              label: connection.label,
                            })
                          }
                        >
                          <span className={styles.connAccountCopy}>
                            <span className={styles.connAccountLabel}>
                              {connection.label}
                            </span>
                            <span className={styles.connAccountPrincipal}>
                              {connection.principal ?? "Principal unavailable"}
                            </span>
                          </span>
                          <span
                            className={styles.connAccountHealth}
                            data-health={connection.health}
                          >
                            {HEALTH_LABEL[connection.health]}
                          </span>
                          <span
                            className={styles.connAccountCheck}
                            aria-hidden="true"
                          >
                            {chosen ? <Icon name="Check" size={13} /> : null}
                          </span>
                        </button>
                      );
                    })}
                  </fieldset>
                ) : null}
                <div className={styles.connPickerActions}>
                  {hasAccountChoice ? null : health === "ok" ? null : health ===
                      "needs-auth" && item.connection ? (
                    <Button
                      variant="soft"
                      size="sm"
                      label={busy ? "Waiting…" : "Authorize"}
                      disabled={busy || !beginAuthorize}
                      onClick={() => void runAuthorize(item)}
                    />
                  ) : (
                    <Button
                      variant="soft"
                      size="sm"
                      label={connecting ? "Cancel" : "Connect"}
                      disabled={busy || !configureConnection}
                      onClick={() =>
                        setConnectingKind((k) =>
                          k === item.kind ? null : item.kind
                        )
                      }
                    />
                  )}
                </div>
                {connecting ? (
                  <ConnectInlineForm
                    item={item}
                    busy={busy}
                    onCancel={() => setConnectingKind(null)}
                    onSubmit={(input) => void runConfigure(item, input)}
                  />
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </dialog>
  );
}
