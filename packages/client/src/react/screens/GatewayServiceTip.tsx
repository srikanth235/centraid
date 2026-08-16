import { useEffect, useState } from "react";
import type { JSX } from "react";

import styles from "./GatewayServiceTip.module.css";

/**
 * The H5 "keep the gateway up when Centraid is closed" offer.
 *
 * This used to be a BLOCKING onboarding step: a first-time user was asked to
 * decide about installing a background OS service before they had seen a single
 * screen of the product. It is now an informational tip on the Gateway page,
 * where the question is actually motivated — the user is already looking at
 * gateway uptime when they read it.
 *
 * Onboarding leaves `offerGatewayService` unset, and `shouldOfferServiceInstall`
 * (apps/desktop/src/main/detached-gateway-core.ts) treats unset as
 * still-offerable — so this component is what keeps the capability reachable.
 * It is the ONLY caller of `installGatewayService` in the client; deleting it
 * would strand the feature.
 *
 * Which is exactly why it renders TWO things, not one. "Dismiss" writes
 * `offerGatewayService: false`, and that write is permanent by design — the
 * promotion must not return on every relaunch. But when the promotion was the
 * only control, one click retired a real capability with no way back. So a
 * dismissal now demotes instead of deleting: the tip is replaced by a standing
 * one-line control that lives on the Gateway screen from then on. Dismiss
 * dismisses the *promotion*; the *feature* keeps a home.
 */
type Decision =
  /** Settings not read yet — render nothing rather than flash a tip. */
  | "loading"
  /** `offerGatewayService` absent: never asked. Show the promotion. */
  | "unset"
  /** Explicit false: asked and declined. Show the standing control only. */
  | "dismissed"
  /** Explicit true: the service is installed. Nothing left to offer. */
  | "installed";

export interface GatewayServiceTipProps {
  /** Test seam: defaults to the desktop bridge. */
  api?: typeof window.CentraidApi;
}

export default function GatewayServiceTip({
  api = typeof window === "undefined" ? undefined : window.CentraidApi,
}: GatewayServiceTipProps = {}): JSX.Element | null {
  const [decision, setDecision] = useState<Decision>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Web has no local gateway to keep alive, so the bridge method is absent.
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
        // An unreadable setting must not hide the offer forever; treat it as
        // undecided so the user can still reach the feature.
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
        // Awaited: a rejected save used to be invisible, so a dismissal
        // silently didn't stick and the offer came back.
        await api?.saveSettings?.({ offerGatewayService: accept });
        // Clearing `busy` used to be pointless — every decision unmounted the
        // component. A dismissal now leaves the standing control behind, and a
        // stuck `busy` would render it permanently disabled and mid-install.
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

  // Declined: the promotion is gone for good, the capability is not. One quiet
  // line naming the real consequence of leaving it off, and the action itself.
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
