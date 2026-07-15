import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ReplicaShellSession } from '../../../replica/shell-session.js';
import type { ReplicaInvalidation } from '../../../replica/types.js';
import { attachAppFrameReplicaBridge } from './appFrameReplicaBridge.js';

const frames: HTMLIFrameElement[] = [];

afterEach(() => {
  for (const frame of frames) frame.remove();
  frames.length = 0;
});

describe('attachAppFrameReplicaBridge', () => {
  test('binds one nonce-authenticated document port and revokes it on later navigation', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    frames.push(frame);
    const read = vi.fn().mockResolvedValue({ rows: [], cursor: { epoch: 'e', seq: 1 } });
    const search = vi.fn().mockResolvedValue({ rows: [], cursor: { epoch: 'e', seq: 1 } });
    const write = vi.fn().mockResolvedValue({ intentId: 'intent-1', payloadHash: 'hash' });
    let invalidate: ((values: readonly ReplicaInvalidation[]) => void) | undefined;
    let legacyInvalidate: ((values: readonly ReplicaInvalidation[]) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((_appId, dependencies, listener) => {
      if (dependencies === undefined) legacyInvalidate = listener;
      else invalidate = listener;
      return unsubscribe;
    });
    const session = { read, search, write, subscribe } as unknown as ReplicaShellSession;
    const fetchResource = vi.fn().mockResolvedValue({
      url: 'https://shell.test/__centraid_iroh__/d-one/centraid/_vault/blobs/sha',
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'image/jpeg']],
      body: new Uint8Array([1, 2, 3]).buffer,
    });
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
    const detach = attachAppFrameReplicaBridge(frame, 'todos', {
      documentNonce: 'document-one',
      getSession: async () => session,
      fetchResource,
    });

    // The reusable iframe Window is not an RPC channel, even for the right app.
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'centraid:replica-read',
          id: 'window-read',
          appId: 'todos',
          request: { entity: 'core.task' },
        },
      }),
    );
    expect(read).not.toHaveBeenCalled();

    // Wrong app and wrong document nonce cannot obtain a capability port.
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'centraid:replica-ready',
          appId: 'notes',
          documentNonce: 'document-one',
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'centraid:replica-ready',
          appId: 'todos',
          documentNonce: 'document-two',
        },
      }),
    );
    expect(postMessage).not.toHaveBeenCalled();

    // The bridge emits changes-ready first while parsing, then replica-ready.
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'centraid:changes-ready',
          appId: 'todos',
          documentNonce: 'document-one',
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'centraid:replica-ready',
          appId: 'todos',
          documentNonce: 'document-one',
        },
      }),
    );
    expect(postMessage).toHaveBeenCalledTimes(1);
    const handshakeCall = postMessage.mock.calls[0] as unknown as [unknown, string, Transferable[]];
    expect(handshakeCall[0]).toEqual({
      type: 'centraid:replica-parent',
      documentNonce: 'document-one',
    });
    expect(handshakeCall[1]).toBe('*');
    const childPort = handshakeCall[2][0] as MessagePort;
    const childMessages: unknown[] = [];
    childPort.addEventListener('message', (event) => childMessages.push(event.data));
    childPort.start();

    await vi.waitFor(() =>
      expect(subscribe).toHaveBeenCalledWith('todos', undefined, expect.any(Function)),
    );
    await vi.waitFor(() =>
      expect(childMessages).toContainEqual({ type: 'centraid:changes-parent' }),
    );
    legacyInvalidate?.([
      { shapeId: 'shape-todos', entity: 'core.task', rowId: 'task-1', source: 'canonical' },
      { shapeId: '*', entity: '*', source: 'purge' },
    ]);
    await vi.waitFor(() =>
      expect(childMessages).toContainEqual({
        type: 'centraid:vault-change',
        detail: {
          shapeId: 'shape-todos',
          entity: 'core.task',
          rowId: 'task-1',
          source: 'canonical',
        },
      }),
    );
    expect(childMessages).toContainEqual({
      type: 'centraid:vault-rebootstrap',
      detail: { shapeId: '*', entity: '*', source: 'purge' },
    });

    childPort.postMessage(
      {
        type: 'centraid:replica-read',
        id: 'wrong-app',
        appId: 'notes',
        request: { entity: 'core.task' },
      },
      [],
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).not.toHaveBeenCalled();

    childPort.postMessage(
      {
        type: 'centraid:replica-read',
        id: 'read-1',
        appId: 'todos',
        request: { entity: 'core.task' },
      },
      [],
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith('todos', { entity: 'core.task' }));
    await vi.waitFor(() =>
      expect(childMessages).toContainEqual(
        expect.objectContaining({ type: 'centraid:replica-result', id: 'read-1', ok: true }),
      ),
    );

    childPort.postMessage(
      {
        type: 'centraid:replica-search',
        id: 'search-1',
        appId: 'todos',
        request: { entity: 'core.task', query: 'offline' },
      },
      [],
    );
    await vi.waitFor(() =>
      expect(search).toHaveBeenCalledWith('todos', {
        entity: 'core.task',
        query: 'offline',
      }),
    );
    await vi.waitFor(() =>
      expect(childMessages).toContainEqual(
        expect.objectContaining({ type: 'centraid:replica-result', id: 'search-1', ok: true }),
      ),
    );

    childPort.postMessage(
      {
        type: 'centraid:resource',
        id: 'resource-1',
        appId: 'todos',
        request: {
          url: 'https://shell.test/__centraid_iroh__/d-one/centraid/_vault/blobs/sha',
          method: 'GET',
          headers: [['accept', 'image/jpeg']],
        },
      },
      [],
    );
    await vi.waitFor(() => expect(fetchResource).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(childMessages).toContainEqual(
        expect.objectContaining({
          type: 'centraid:replica-result',
          id: 'resource-1',
          ok: true,
          result: expect.objectContaining({ status: 200 }),
        }),
      ),
    );
    const resourceResult = childMessages.find(
      (value) =>
        (value as { type?: unknown; id?: unknown }).type === 'centraid:replica-result' &&
        (value as { id?: unknown }).id === 'resource-1',
    ) as { result: { body: ArrayBuffer } };
    expect(resourceResult.result.body.byteLength).toBe(3);

    childPort.postMessage(
      {
        type: 'centraid:replica-write',
        id: 2,
        appId: 'todos',
        action: 'complete',
        input: { taskId: 'task-1' },
        intentId: 'intent-1',
      },
      [],
    );
    await vi.waitFor(() =>
      expect(write).toHaveBeenCalledWith('todos', {
        action: 'complete',
        input: { taskId: 'task-1' },
        intentId: 'intent-1',
      }),
    );

    childPort.postMessage(
      {
        type: 'centraid:replica-subscribe',
        appId: 'todos',
        subscriptionId: 'tasks',
        dependencies: [{ entity: 'core.task' }],
      },
      [],
    );
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
    invalidate?.([
      { shapeId: 'shape-todos', entity: 'core.task', rowId: 'task-1', source: 'canonical' },
    ]);
    await vi.waitFor(() =>
      expect(childMessages).toContainEqual({
        type: 'centraid:replica-invalidate',
        subscriptionId: 'tasks',
        invalidations: [
          {
            shapeId: 'shape-todos',
            entity: 'core.task',
            rowId: 'task-1',
            source: 'canonical',
          },
        ],
      }),
    );

    // First load belongs to the document that handshook while parsing. A
    // later load without a matching handshake is an external navigation and
    // closes this port plus both subscriptions.
    frame.dispatchEvent(new Event('load'));
    read.mockClear();
    frame.dispatchEvent(new Event('load'));
    childPort.postMessage(
      {
        type: 'centraid:replica-read',
        id: 'after-navigation',
        appId: 'todos',
        request: { entity: 'core.task' },
      },
      [],
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(2);

    childPort.close();
    detach();
  });

  test('a late subscribe cannot resurrect after its id was unsubscribed', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    frames.push(frame);
    let releaseSession: ((session: ReplicaShellSession) => void) | undefined;
    const sessionPending = new Promise<ReplicaShellSession>((resolve) => {
      releaseSession = resolve;
    });
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const session = { subscribe } as unknown as ReplicaShellSession;
    const getSession = vi.fn(() => sessionPending);
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
    const detach = attachAppFrameReplicaBridge(frame, 'todos', {
      documentNonce: 'document-one',
      getSession,
    });

    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'centraid:replica-ready',
          appId: 'todos',
          documentNonce: 'document-one',
        },
      }),
    );
    const handshake = postMessage.mock.calls[0] as unknown as [unknown, string, Transferable[]];
    const childPort = handshake[2][0] as MessagePort;
    childPort.start();
    childPort.postMessage(
      {
        type: 'centraid:replica-subscribe',
        appId: 'todos',
        subscriptionId: 'tasks',
        dependencies: [{ entity: 'core.task' }],
      },
      [],
    );
    childPort.postMessage(
      {
        type: 'centraid:replica-unsubscribe',
        appId: 'todos',
        subscriptionId: 'tasks',
      },
      [],
    );
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSession?.(session);

    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    childPort.close();
    detach();
  });
});
