import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";

const scrollPositions = new Map<string, number>();
const NEAR_BOTTOM_PX = 60;

export function useAssistantScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  messages: readonly unknown[],
  conversationId: string | undefined
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
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || prevConvRef.current === conversationId) return;
    prevConvRef.current = conversationId;
    const saved = conversationId
      ? scrollPositions.get(conversationId)
      : undefined;
    if (saved === undefined) {
      el.scrollTop = el.scrollHeight;
      stuckRef.current = true;
    } else {
      el.scrollTop = saved;
      stuckRef.current = isAtBottom(el);
    }
    setShowJump(!isAtBottom(el));
  }, [conversationId, scrollRef]);

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
