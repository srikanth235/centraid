// Scroll-aware autoscroll for the assistant transcript (issue #420 §5). The
// old behavior forced `scrollTop = scrollHeight` on every message change, which
// fought a user scrolling up mid-stream. Here we only stick to the bottom when
// the reader is already there, surface a "jump to bottom" pill otherwise, and
// restore each conversation's scroll position when switching threads.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

// Survives route remounts (navigating away and back) — in-memory is enough.
const scrollPositions = new Map<string, number>();
const NEAR_BOTTOM_PX = 60;

export function useAssistantScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  messages: unknown[],
  conversationId: string | undefined,
): { showJump: boolean; jumpToBottom: () => void } {
  const stuckRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const prevConvRef = useRef<string | undefined>(undefined);

  const isAtBottom = (el: HTMLDivElement): boolean =>
    el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuckRef.current = true;
    setShowJump(false);
  }, [scrollRef]);

  // Track the reader's position so auto-stick only fires when already at the
  // bottom, and remember it per conversation for restore-on-switch.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const bottom = isAtBottom(el);
      stuckRef.current = bottom;
      setShowJump(!bottom);
      const key = prevConvRef.current;
      if (key) scrollPositions.set(key, el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef]);

  // Restore the saved position (or the bottom) when the thread changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || prevConvRef.current === conversationId) return;
    prevConvRef.current = conversationId;
    const saved = conversationId ? scrollPositions.get(conversationId) : undefined;
    if (saved !== undefined) {
      el.scrollTop = saved;
      stuckRef.current = isAtBottom(el);
    } else {
      el.scrollTop = el.scrollHeight;
      stuckRef.current = true;
    }
    setShowJump(!isAtBottom(el));
  }, [conversationId, scrollRef]);

  // On new content, stick to the bottom only when the reader already was.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stuckRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(!isAtBottom(el));
    }
  }, [messages, scrollRef]);

  return { showJump, jumpToBottom };
}
