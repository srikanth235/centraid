/**
 * Client courier for Centraid Assist OAuth (issue #526).
 *
 * Authorization material is parsed from a URL fragment, removed from the
 * address bar synchronously, kept only in memory, and delivered to the
 * authenticated gateway. It is never written to local/session storage.
 */

import {
  completeAssistAuthorization,
  type AssistOAuthHandoff,
} from './gateway-client-connections.js';
import { ASSIST_HANDOFF_EVENT, type AssistHandoffResult } from './assist-oauth-events.js';

export function parseAssistHandoffUrl(rawUrl: string): AssistOAuthHandoff | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const webFinish = url.origin === 'https://app.centraid.dev' && url.pathname === '/oauth/finish';
  const desktopFinish =
    url.protocol === 'centraid:' && url.hostname === 'oauth' && url.pathname === '/finish';
  if (!webFinish && !desktopFinish) return undefined;
  const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  const state = bounded(fragment.get('state'), 128);
  if (!state || !/^[dw]\.[A-Za-z0-9_-]{43}$/.test(state)) return undefined;
  const error = bounded(fragment.get('error'), 128);
  if (error) return { state, error };
  const code = bounded(fragment.get('code'), 4096);
  const receipt = bounded(fragment.get('receipt'), 1024);
  if (!code || !receipt) return undefined;
  return { state, code, receipt };
}

export async function consumeInitialAssistHandoff(): Promise<AssistHandoffResult> {
  if (window.location.pathname !== '/oauth/finish') return { status: 'none' };
  const canonical = new URL('/oauth/finish', 'https://app.centraid.dev');
  canonical.hash = window.location.hash;
  const handoff = parseAssistHandoffUrl(canonical.toString());
  // Scrub before any network call, render, log, or error handling.
  window.history.replaceState(null, '', '/');
  if (!handoff) {
    return {
      status: 'error',
      message: 'This Centraid Assist return link is incomplete. Start Connect again.',
    };
  }
  return completeHandoff(handoff);
}

export function installDesktopAssistHandoff(): () => void {
  const subscribe = window.CentraidApi.onDeepLink;
  if (!subscribe) return () => undefined;
  return subscribe((rawUrl) => {
    const handoff = parseAssistHandoffUrl(rawUrl);
    if (!handoff) return;
    void completeHandoff(handoff).then((result) => {
      window.dispatchEvent(
        new CustomEvent<AssistHandoffResult>(ASSIST_HANDOFF_EVENT, { detail: result }),
      );
    });
  });
}

/** Manual desktop fallback for environments that block custom-scheme launch. */
export async function completeAssistReturnLink(rawUrl: string): Promise<{ connectionId: string }> {
  const handoff = parseAssistHandoffUrl(rawUrl.trim());
  if (!handoff) {
    throw new Error(
      'That return link is not a valid Centraid Assist link. Copy the complete centraid://oauth/finish link.',
    );
  }
  const result = await completeHandoff(handoff);
  if (result.status === 'complete') return { connectionId: result.connectionId };
  throw new Error(
    result.status === 'error'
      ? result.message
      : 'The return link did not contain an authorization handoff.',
  );
}

async function completeHandoff(handoff: AssistOAuthHandoff): Promise<AssistHandoffResult> {
  try {
    const completed = await completeAssistAuthorization(handoff);
    return { status: 'complete', connectionId: completed.connectionId };
  } catch (err) {
    return {
      status: 'error',
      message:
        err instanceof Error
          ? err.message
          : 'Centraid Assist could not complete authorization. Start Connect again.',
    };
  }
}

function bounded(value: string | null, maxLength: number): string | undefined {
  return value && value.length <= maxLength ? value : undefined;
}
