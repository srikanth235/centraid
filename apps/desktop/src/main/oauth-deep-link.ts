/**
 * Main-process allowlist for OAuth courier links. Keep this module free of
 * Electron imports so malformed/unbounded protocol input is unit-testable.
 */
export function isOAuthFinishDeepLink(rawUrl: string): boolean {
  if (rawUrl.length === 0 || rawUrl.length > 7_000) return false;
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== 'centraid:' ||
      url.hostname !== 'oauth' ||
      url.pathname !== '/finish' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      !url.hash
    ) {
      return false;
    }
    const fragment = new URLSearchParams(url.hash.slice(1));
    const state = fragment.get('state');
    if (!state || !/^d\.[A-Za-z0-9_-]{43}$/.test(state)) return false;
    const providerError = fragment.get('error');
    if (providerError) {
      return providerError.length <= 128 && fragment.size === 2;
    }
    const code = fragment.get('code');
    const receipt = fragment.get('receipt');
    return (
      fragment.size === 3 &&
      typeof code === 'string' &&
      code.length > 0 &&
      code.length <= 4_096 &&
      typeof receipt === 'string' &&
      /^v1\.\d{10}\.[A-Za-z0-9_-]{43}$/.test(receipt)
    );
  } catch {
    return false;
  }
}

/**
 * Preload-side handoff queue. Electron may deliver a warm deep link after the
 * document loads but before the renderer bundle subscribes. Registering the
 * IPC listener in preload and buffering here closes that race without ever
 * persisting the code-bearing URL.
 */
export function createDeepLinkBuffer(limit = 4): {
  push(url: string): void;
  subscribe(listener: (url: string) => void): () => void;
} {
  const pending: string[] = [];
  let activeListener: ((url: string) => void) | undefined;
  return {
    push(url) {
      if (activeListener) {
        activeListener(url);
        return;
      }
      if (pending.length < limit) pending.push(url);
    },
    subscribe(listener) {
      activeListener = listener;
      for (;;) {
        const url = pending.shift();
        if (!url) break;
        listener(url);
      }
      return () => {
        if (activeListener === listener) activeListener = undefined;
      };
    },
  };
}
