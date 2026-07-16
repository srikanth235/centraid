// Wire protocol shared by the WebView-side injected JS and the RN-side
// dispatcher. Kept in one tiny module so both halves stay in sync.

export type BridgeMethod =
  | 'notify.schedule'
  | 'notify.cancel'
  | 'haptic.impact'
  | 'haptic.selection'
  | 'haptic.success'
  | 'transfer.putBackground'
  | 'timer.startBackground'
  | 'timer.cancel';

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
