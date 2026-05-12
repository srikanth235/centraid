// Wire protocol shared by the WebView-side injected JS and the RN-side
// dispatcher. Kept in one tiny module so both halves stay in sync.

export type BridgeMethod =
  | 'notify.schedule'
  | 'notify.cancel'
  | 'haptic.impact'
  | 'haptic.selection'
  | 'haptic.success'
  | 'timer.startBackground'
  | 'timer.cancel'
  | 'gateway.fetch';

/**
 * Args for `gateway.fetch`. The injected `window.fetch` shim intercepts
 * gateway-origin (and relative `/centraid/...`) requests and routes them
 * through this method so native can attach the bearer header.
 */
export interface GatewayFetchArgs {
  /** Absolute URL — origin must match the configured gateway. */
  url: string;
  method?: string;
  /** Pre-flattened headers ({} when absent). */
  headers?: Record<string, string>;
  /** Body as text. Binary bodies aren't supported (centraid handlers don't need them). */
  body?: string;
}

export interface GatewayFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Response body as text. */
  body: string;
}

export interface BridgeRequest {
  /** Correlator chosen by the WebView caller. */
  id: string;
  method: BridgeMethod;
  /** Single-arg payload — methods that take multiple args wrap them in an object. */
  args?: unknown;
}

export interface BridgeOk<T = unknown> {
  id: string;
  ok: true;
  value?: T;
}

export interface BridgeErr {
  id: string;
  ok: false;
  error: {
    /** Stable code that templates can switch on (e.g. `permission_denied`). */
    code: string;
    message: string;
  };
}

export type BridgeResponse<T = unknown> = BridgeOk<T> | BridgeErr;

export const CENTRAID_HANDSHAKE = '__centraid_bridge_v1__';
