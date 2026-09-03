import { useEffect, useState } from "react";
import type { JSX } from "react";

import styles from "./GatewayServiceTip.module.css";

type Decision = "loading" | "unset" | "dismissed" | "installed";

export interface GatewayServiceTipProps {
  api?: typeof window.CentraidApi;
}

export default function GatewayServiceTip({
  api = typeof window === "undefined" ? undefined : window.CentraidApi,
}: GatewayServiceTipProps = {}): JSX.Element | null {
  const [decision, setDecision] = useState<Decision>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = api?.installGatewayService;

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(api?.getSettings?.())
      .then((settings) => {
        if (cancelled) return;
        const value = settings?.offerGatewayService;
        setDecision(
          value === true ? "installed" : value === false ? "dismissed" : "unset"
        );
      })
      .catch(() => {
        if (!cancelled) setDecision("unset");
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!install || decision === "loading" || decision === "installed") {
    return null;
  }

  const decide = (accept: boolean): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        if (accept) {
          const res = await install();
          if (!res.ok) {
            setBusy(false);
            setError(res.error || "Service install failed");
            return;
          }
        }
        await api?.saveSettings?.({ offerGatewayService: accept });
        setBusy(false);
        setDecision(accept ? "installed" : "dismissed");
      } catch (caughtError) {
        setBusy(false);
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError)
        );
      }
    })();
  };

  const errorLine = error ? (
    <p className={styles.error} role="alert">
      {error}
    </p>
  ) : null;

  if (decision === "dismissed") {
    return (
      <div className={styles.standing} data-testid="gateway-service-standing">
        <p className={styles.standingCopy}>
          This gateway runs inside Centraid — quit the app and your phone can’t
          reach your vault until you open it again.
        </p>
        {errorLine}
        <button
          type="button"
          className={styles.quiet}
          disabled={busy}
          data-testid="gateway-service-install"
          onClick={() => decide(true)}
        >
          {busy ? "Installing…" : "Install as a background service"}
        </button>
      </div>
    );
  }

  return (
    <aside className={styles.tip} data-testid="gateway-service-tip">
      <span className={styles.icon} aria-hidden="true" />
      <div className={styles.body}>
        <p className={styles.headline}>Keep your vault reachable</p>
        <p className={styles.copy}>
          A small background service keeps this gateway up when Centraid is
          closed, so your phone can still reach your vault. Nothing is installed
          unless you ask.
        </p>
        {errorLine}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={busy}
          data-testid="gateway-service-tip-accept"
          onClick={() => decide(true)}
        >
          {busy ? "Installing…" : "Install"}
        </button>
        <button
          type="button"
          className={styles.dismiss}
          disabled={busy}
          data-testid="gateway-service-tip-dismiss"
          onClick={() => decide(false)}
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
