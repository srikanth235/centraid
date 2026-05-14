/*
 * Minimal Gateway WS client.
 *
 * Talks to an OpenClaw gateway as a trusted backend loopback client. The full
 * `@openclaw/sdk` package is monorepo-internal (imports the gateway client by
 * relative path) and not published to npm, so we speak the wire protocol
 * directly. We only implement the slice we need: connect → hello-ok → request/
 * response correlation → server-pushed events.
 *
 * **Loopback-only.** `buildConnectParams` sets `client.id: "gateway-client"`,
 * `mode: "backend"`, and omits the `device` field. That combination authenticates
 * against the trusted same-process exemption documented at
 * https://docs.openclaw.ai/gateway/protocol — it only works when the gateway URL
 * is loopback AND a shared `auth.token` is provided. A remote gateway with
 * device pairing would reject this handshake. If we ever need to talk to a
 * non-loopback gateway, add device-token + signature support to `sendConnect`.
 *
 * Protocol reference: https://docs.openclaw.ai/gateway/protocol
 * Frame shapes verified against `packages/sdk/src/index.e2e.test.ts` in the
 * openclaw monorepo.
 */

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

export interface GatewayWsOptions {
  /** Gateway base URL — accepts `http(s)://...` or `ws(s)://...`. */
  url: string;
  /** Bearer token (or empty for loopback no-auth mode). */
  token?: string;
  /** Connection + request timeout. Default 30s. */
  timeoutMs?: number;
}

interface ReqFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}
interface ResFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
}
interface EventFrame {
  type: 'event';
  event: string;
  seq?: number;
  payload?: unknown;
}
type ServerFrame = ResFrame | EventFrame;

export interface GatewayEvent {
  event: string;
  payload?: unknown;
  seq?: number;
}

type EventHandler = (event: GatewayEvent) => void;

export class GatewayWsClient {
  private ws: WebSocket | null = null;
  private connectedP: Promise<void> | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly subscribers = new Set<EventHandler>();
  private closed = false;
  private onCloseCb: (() => void) | null = null;

  constructor(private readonly opts: GatewayWsOptions) {}

  /** Notified when the underlying WS closes (gateway restart, etc.). */
  onClose(cb: () => void): void {
    this.onCloseCb = cb;
  }

  /** True after the WS has been observed closed or torn down by `close()`. */
  isClosed(): boolean {
    return this.closed;
  }

  /** Ensure the WS is open and the `connect` handshake has succeeded. */
  connect(): Promise<void> {
    if (this.connectedP) return this.connectedP;
    this.connectedP = this.doConnect().catch((err) => {
      this.connectedP = null;
      throw err;
    });
    return this.connectedP;
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = this.toWsUrl(this.opts.url);
      const ws = new WebSocket(wsUrl, {
        // Loopback gateways may run with self-signed certs; allow tlsverify
        // to be bypassed when explicitly hitting 127.0.0.1.
        rejectUnauthorized: !/^wss?:\/\/127\.0\.0\.1/.test(wsUrl),
      });
      this.ws = ws;
      const timeoutMs = this.opts.timeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`gateway connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.on('message', (raw) => this.onMessage(raw.toString('utf8')));
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        this.handleClose(code, reason.toString('utf8'));
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      // The first frame from the gateway is `connect.challenge`. Wait for it,
      // then send our `connect` request as a trusted backend loopback client.
      const onChallenge = (event: GatewayEvent): void => {
        if (event.event !== 'connect.challenge') return;
        this.subscribers.delete(onChallenge);
        const id = randomUUID();
        const params = this.buildConnectParams();
        const onResolve = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const onReject = (err: Error): void => {
          clearTimeout(timer);
          ws.close();
          reject(err);
        };
        this.pending.set(id, {
          resolve: () => onResolve(),
          reject: onReject,
          timer: setTimeout(
            () => onReject(new Error(`connect request timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        });
        ws.send(JSON.stringify({ type: 'req', id, method: 'connect', params } as ReqFrame));
      };
      this.subscribers.add(onChallenge);
    });
  }

  private buildConnectParams(): Record<string, unknown> {
    const auth = this.opts.token ? { token: this.opts.token } : undefined;
    return {
      minProtocol: 3,
      maxProtocol: 4,
      client: {
        id: 'gateway-client',
        version: '0.1.0',
        platform: process.platform,
        mode: 'backend',
      },
      // Opt into tool-event delivery — without this cap the gateway only
      // broadcasts assistant/lifecycle frames to us; tool start/result frames
      // go to the per-conn `toolEventRecipients` registry (see openclaw's
      // server-chat.js `createAgentEventHandler`, lines ~499–516). The in-app
      // chat panel needs them to show the "Querying ×N" tool pills.
      caps: ['tool-events'],
      auth,
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
    };
  }

  private toWsUrl(url: string): string {
    if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
    if (url.startsWith('http://')) return 'ws://' + url.slice('http://'.length);
    if (url.startsWith('https://')) return 'wss://' + url.slice('https://'.length);
    return url;
  }

  private onMessage(text: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(text) as ServerFrame;
    } catch {
      return;
    }
    if (frame.type === 'event') {
      const evt: GatewayEvent = {
        event: frame.event,
        payload: frame.payload,
        seq: frame.seq,
      };
      // Snapshot the subscriber set so a callback that unsubscribes mid-fan-out
      // (e.g. the handshake's `connect.challenge` handler) doesn't disturb
      // iteration.
      const snapshot = Array.from(this.subscribers);
      for (const cb of snapshot) {
        try {
          cb(evt);
        } catch {
          /* swallow */
        }
      }
      return;
    }
    if (frame.type === 'res') {
      const slot = this.pending.get(frame.id);
      if (!slot) return;
      clearTimeout(slot.timer);
      this.pending.delete(frame.id);
      if (frame.ok) slot.resolve(frame.payload);
      else slot.reject(new Error(frame.error?.message ?? 'gateway request failed'));
    }
  }

  private handleClose(code: number, reason: string): void {
    this.closed = true;
    const err = new Error(`gateway WS closed (${code}): ${reason || 'no reason'}`);
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(err);
    }
    this.pending.clear();
    this.subscribers.clear();
    const cb = this.onCloseCb;
    this.onCloseCb = null;
    cb?.();
  }

  /** Fire an RPC and await the response. */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    await this.connect();
    if (!this.ws || this.closed) throw new Error('gateway WS is not open');
    const id = randomUUID();
    const budget = timeoutMs ?? this.opts.timeoutMs ?? 30_000;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request "${method}" timed out after ${budget}ms`));
      }, budget);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify({ type: 'req', id, method, params } as ReqFrame));
    });
  }

  /** Subscribe to all server-pushed events. Returns an unsubscribe fn. */
  onEvent(cb: EventHandler): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}
