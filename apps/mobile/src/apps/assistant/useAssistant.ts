// Controller for the vault-assistant chat cover (issue #498; assistant surface
// #286). v0 owns the conversation *surface* — phase, message bubbles, the send
// action — while the real streamed gateway turn is deferred (see the PR notes):
// the gateway conversation endpoint the phone will POST to isn't wired here yet.
//
// So this keeps the UI honest: 'offline' when no gateway is reachable, 'ready'
// once one is, and a local acknowledgement on send so the composer, bubbles and
// scroll behaviour are all real and testable. Swapping the stubbed reply for a
// buffered (then streamed) gateway turn is a drop-in change to `send` below.

import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveGatewayBase } from '../../lib/gateway';

export interface Bubble {
  key: string;
  role: 'user' | 'assistant';
  text: string;
  // An assistant bubble awaiting its reply renders a "Thinking…" placeholder.
  pending?: boolean;
  // A failed turn renders in the error colour.
  error?: boolean;
}

export type AssistantPhase = 'connecting' | 'offline' | 'ready';

export interface AssistantController {
  phase: AssistantPhase;
  bubbles: Bubble[];
  sending: boolean;
  loadError: string | undefined;
  send: (text: string) => void;
}

const PREVIEW_REPLY =
  "I'm a preview of your space assistant. Chatting with your vault turns on once " +
  'the gateway conversation endpoint is wired up — the composer and history here ' +
  'are already live.';

let counter = 0;
function nextKey(): string {
  counter += 1;
  return `b${counter}`;
}

export function useAssistant(): AssistantController {
  const [phase, setPhase] = useState<AssistantPhase>('connecting');
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [sending, setSending] = useState(false);
  // History load is a no-op in v0 — kept in the contract so wiring a real
  // `GET conversation` later only fills this in.
  const loadError: string | undefined = undefined;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void resolveGatewayBase().then((base) => {
      if (!mounted.current) return;
      setPhase(base ? 'ready' : 'offline');
    });
    return () => {
      mounted.current = false;
    };
  }, []);

  const send = useCallback((text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const pendingKey = nextKey();
    setBubbles((prev) => [
      ...prev,
      { key: nextKey(), role: 'user', text: trimmed },
      { key: pendingKey, role: 'assistant', text: '', pending: true },
    ]);
    setSending(true);
    // Buffered turn: resolve the pending bubble after a short beat so the
    // "Thinking…" state is visible. Replace this timer with the gateway call.
    setTimeout(() => {
      if (!mounted.current) return;
      setBubbles((prev) =>
        prev.map((b) => (b.key === pendingKey ? { ...b, pending: false, text: PREVIEW_REPLY } : b)),
      );
      setSending(false);
    }, 600);
  }, []);

  return { phase, bubbles, sending, loadError, send };
}
