import type {
  ReplicaShellSession,
  ShellOptimisticMutation,
  ShellReplicaReadRequest,
  ShellReplicaSearchRequest,
} from '../../../replica/shell-session.js';
import type { ReplicaDependency, ReplicaValue } from '../../../replica/types.js';

type RequestId = string | number;

interface ReplicaReadMessage {
  type: 'centraid:replica-read';
  id: RequestId;
  appId: string;
  request: ShellReplicaReadRequest;
}

interface ReplicaSearchMessage {
  type: 'centraid:replica-search';
  id: RequestId;
  appId: string;
  request: ShellReplicaSearchRequest;
}

interface ReplicaWriteMessage {
  type: 'centraid:replica-write';
  id: RequestId;
  appId: string;
  action: string;
  input: ReplicaValue;
  optimistic?: ShellOptimisticMutation[];
  intentId?: string;
}

interface ReplicaSubscriptionMessage {
  type: 'centraid:replica-subscribe' | 'centraid:replica-unsubscribe';
  appId: string;
  subscriptionId: string;
  dependencies?: Array<ShellReplicaReadRequest | ReplicaDependency>;
}

export interface AppFrameResourceRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body?: ArrayBuffer;
}

export interface AppFrameResourceResponse {
  url: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
}

interface ResourceMessage {
  type: 'centraid:resource';
  id: RequestId;
  appId: string;
  request: AppFrameResourceRequest;
}

interface ReplicaReadyMessage {
  type: 'centraid:replica-ready';
  appId: string;
  documentNonce: string;
}

interface ChangesReadyMessage {
  type: 'centraid:changes-ready';
  appId: string;
  documentNonce: string;
}

type ReplicaPortMessage =
  | ReplicaReadMessage
  | ReplicaSearchMessage
  | ReplicaWriteMessage
  | ReplicaSubscriptionMessage
  | ResourceMessage;
type ReplicaReadyWindowMessage = ReplicaReadyMessage | ChangesReadyMessage;

export interface AppFrameReplicaBridgeOptions {
  /** Unpredictable capability embedded only in this generated document's URL fragment. */
  documentNonce: string;
  getSession?: () => Promise<ReplicaShellSession>;
  fetchResource?: (request: AppFrameResourceRequest) => Promise<AppFrameResourceResponse>;
}

/** Secure shell RPC bound to one document-owned MessagePort, never the reusable iframe Window. */
export function attachAppFrameReplicaBridge(
  frame: HTMLIFrameElement,
  appId: string,
  options: AppFrameReplicaBridgeOptions,
): () => void {
  const getSession =
    options.getSession ??
    (() =>
      import('../../../replica/shell-session.js').then((module) =>
        module.getReplicaShellSession(),
      ));
  const subscriptions = new Map<string, () => void>();
  const subscriptionTokens = new Map<string, symbol>();
  let port: MessagePort | undefined;
  let generation = 0;
  let legacyUnsubscribe: (() => void) | undefined;
  let legacyStarting: Promise<void> | undefined;
  let legacyRequested = false;
  let handshookSinceLoad = false;
  let active = true;

  const clearSubscriptions = (): void => {
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    subscriptionTokens.clear();
    legacyUnsubscribe?.();
    legacyUnsubscribe = undefined;
  };

  const revokePort = (): void => {
    generation += 1;
    port?.close();
    port = undefined;
    legacyStarting = undefined;
    clearSubscriptions();
  };

  const post = (
    message: unknown,
    expectedGeneration = generation,
    transfer: Transferable[] = [],
  ): void => {
    if (!active || expectedGeneration !== generation || !port) return;
    try {
      port.postMessage(message, transfer);
    } catch {
      /* A navigating document can lose its capability port between async steps. */
    }
  };

  const startLegacyInvalidations = (expectedGeneration: number): void => {
    if (legacyUnsubscribe || legacyStarting) return;
    const starting = getSession()
      .then((session) => {
        if (!active || expectedGeneration !== generation || !port) return;
        legacyUnsubscribe = session.subscribe(appId, undefined, (invalidations) => {
          for (const invalidation of invalidations) {
            if (invalidation.source === 'purge') {
              post(
                { type: 'centraid:vault-rebootstrap', detail: invalidation },
                expectedGeneration,
              );
            } else {
              post({ type: 'centraid:vault-change', detail: invalidation }, expectedGeneration);
            }
          }
        });
        post({ type: 'centraid:changes-parent' }, expectedGeneration);
      })
      .catch(() => undefined)
      .finally(() => {
        if (legacyStarting === starting) legacyStarting = undefined;
      });
    legacyStarting = starting;
  };

  const result = async (
    id: RequestId,
    work: () => Promise<unknown>,
    expectedGeneration: number,
  ): Promise<void> => {
    try {
      const value = await work();
      post({ type: 'centraid:replica-result', id, ok: true, result: value }, expectedGeneration);
    } catch (error) {
      const shaped = serializeReplicaError(error);
      post({ type: 'centraid:replica-result', id, ok: false, ...shaped }, expectedGeneration);
    }
  };

  const onPortMessage = (value: unknown, expectedGeneration: number): void => {
    if (expectedGeneration !== generation || !isReplicaPortMessage(value, appId)) return;
    const message = value;
    if (message.type === 'centraid:resource') {
      void (async () => {
        try {
          if (!options.fetchResource) throw resourceUnavailable();
          const response = await options.fetchResource(message.request);
          post(
            {
              type: 'centraid:replica-result',
              id: message.id,
              ok: true,
              result: response,
            },
            expectedGeneration,
            [response.body],
          );
        } catch (error) {
          const shaped = serializeReplicaError(error);
          post(
            { type: 'centraid:replica-result', id: message.id, ok: false, ...shaped },
            expectedGeneration,
          );
        }
      })();
      return;
    }
    if (message.type === 'centraid:replica-read') {
      void result(
        message.id,
        async () => {
          const session = await getSession();
          return session.read(appId, message.request);
        },
        expectedGeneration,
      );
      return;
    }
    if (message.type === 'centraid:replica-search') {
      void result(
        message.id,
        async () => {
          const session = await getSession();
          return session.search(appId, message.request);
        },
        expectedGeneration,
      );
      return;
    }
    if (message.type === 'centraid:replica-write') {
      void result(
        message.id,
        async () => {
          const session = await getSession();
          return session.write(appId, {
            action: message.action,
            input: message.input,
            ...(message.optimistic ? { optimistic: message.optimistic } : {}),
            ...(message.intentId ? { intentId: message.intentId } : {}),
          });
        },
        expectedGeneration,
      );
      return;
    }
    if (message.type === 'centraid:replica-unsubscribe') {
      subscriptionTokens.delete(message.subscriptionId);
      subscriptions.get(message.subscriptionId)?.();
      subscriptions.delete(message.subscriptionId);
      return;
    }
    const subscriptionToken = Symbol(message.subscriptionId);
    subscriptionTokens.set(message.subscriptionId, subscriptionToken);
    subscriptions.get(message.subscriptionId)?.();
    subscriptions.delete(message.subscriptionId);
    void getSession()
      .then((session) => {
        const unsubscribe = session.subscribe(appId, message.dependencies, (invalidations) => {
          post(
            {
              type: 'centraid:replica-invalidate',
              subscriptionId: message.subscriptionId,
              invalidations,
            },
            expectedGeneration,
          );
        });
        if (
          active &&
          expectedGeneration === generation &&
          subscriptionTokens.get(message.subscriptionId) === subscriptionToken
        ) {
          subscriptions.set(message.subscriptionId, unsubscribe);
        } else unsubscribe();
      })
      .catch(() => {
        if (subscriptionTokens.get(message.subscriptionId) === subscriptionToken) {
          subscriptionTokens.delete(message.subscriptionId);
        }
      });
  };

  const establishPort = (): void => {
    revokePort();
    const channel = new MessageChannel();
    const expectedGeneration = generation;
    port = channel.port1;
    port.addEventListener('message', (event) => onPortMessage(event.data, expectedGeneration));
    port.start();
    handshookSinceLoad = true;
    try {
      frame.contentWindow?.postMessage(
        {
          type: 'centraid:replica-parent',
          documentNonce: options.documentNonce,
        },
        '*',
        [channel.port2],
      );
    } catch {
      revokePort();
      return;
    }
    if (legacyRequested) startLegacyInvalidations(expectedGeneration);
  };

  const onWindowMessage = (event: MessageEvent): void => {
    if (
      event.source !== frame.contentWindow ||
      !isReadyWindowMessage(event.data, appId, options.documentNonce)
    ) {
      return;
    }
    if (event.data.type === 'centraid:changes-ready') {
      legacyRequested = true;
      if (port) startLegacyInvalidations(generation);
      return;
    }
    establishPort();
  };

  const onLoad = (): void => {
    // The injected bridge handshakes during parsing, before load. A load with
    // no matching nonce handshake is a different/external document: revoke
    // the old capability even though HTMLIFrameElement.contentWindow is reused.
    if (!handshookSinceLoad) {
      legacyRequested = false;
      revokePort();
    }
    handshookSinceLoad = false;
  };

  frame.addEventListener('load', onLoad);
  window.addEventListener('message', onWindowMessage);
  return () => {
    active = false;
    frame.removeEventListener('load', onLoad);
    window.removeEventListener('message', onWindowMessage);
    revokePort();
  };
}

function isReadyWindowMessage(
  value: unknown,
  appId: string,
  documentNonce: string,
): value is ReplicaReadyWindowMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.appId === appId &&
    message.documentNonce === documentNonce &&
    (message.type === 'centraid:replica-ready' || message.type === 'centraid:changes-ready')
  );
}

function isReplicaPortMessage(value: unknown, appId: string): value is ReplicaPortMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.appId !== appId || typeof message.type !== 'string') return false;
  if (message.type === 'centraid:replica-read' || message.type === 'centraid:replica-search') {
    return validId(message.id) && Boolean(message.request) && typeof message.request === 'object';
  }
  if (message.type === 'centraid:replica-write') {
    return validId(message.id) && typeof message.action === 'string' && 'input' in message;
  }
  if (message.type === 'centraid:resource') {
    if (!validId(message.id) || !message.request || typeof message.request !== 'object') {
      return false;
    }
    const request = message.request as Record<string, unknown>;
    return (
      typeof request.url === 'string' &&
      typeof request.method === 'string' &&
      Array.isArray(request.headers) &&
      (request.body === undefined || request.body instanceof ArrayBuffer)
    );
  }
  return (
    (message.type === 'centraid:replica-subscribe' ||
      message.type === 'centraid:replica-unsubscribe') &&
    typeof message.subscriptionId === 'string'
  );
}

function resourceUnavailable(): Error & { code: string } {
  return Object.assign(new Error('App resource bridge is unavailable.'), {
    code: 'APP_RESOURCE_UNAVAILABLE',
  });
}

function validId(value: unknown): value is RequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function serializeReplicaError(error: unknown): { error: string; code: string } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      error: error.message,
      code: typeof code === 'string' ? code : 'REPLICA_UNAVAILABLE',
    };
  }
  return { error: String(error), code: 'REPLICA_UNAVAILABLE' };
}
