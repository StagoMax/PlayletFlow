import { useEffect, useLayoutEffect, useRef, useState, type UIEventHandler } from "react";

const latestThreshold = 48;

export function useConversationScroll({
  messageCount,
  latestEventSeq,
  loadingOlder,
}: {
  messageCount: number;
  latestEventSeq: number;
  loadingOlder: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const beforeOlderHeight = useRef<number | null>(null);
  const wasLoadingOlder = useRef(false);
  const scrollFrame = useRef(0);
  const [awayFromLatest, setAwayFromLatest] = useState(false);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (wasLoadingOlder.current && !loadingOlder && beforeOlderHeight.current !== null) {
      element.scrollTop += element.scrollHeight - beforeOlderHeight.current;
      beforeOlderHeight.current = null;
    } else if (pinnedRef.current) {
      element.scrollTop = element.scrollHeight;
    }
    wasLoadingOlder.current = loadingOlder;
  }, [messageCount, latestEventSeq, loadingOlder]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = requestAnimationFrame(() => {
        const element = scrollRef.current;
        if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(scrollFrame.current);
    };
  }, []);

  const onScroll: UIEventHandler<HTMLDivElement> = (event) => {
    const element = event.currentTarget;
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      const away = element.scrollHeight - element.clientHeight - element.scrollTop > latestThreshold;
      pinnedRef.current = !away;
      setAwayFromLatest((current) => current === away ? current : away);
    });
  };

  function prepareForOlderMessages() {
    beforeOlderHeight.current = scrollRef.current?.scrollHeight ?? null;
  }

  function scrollToLatest() {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = true;
    setAwayFromLatest(false);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({ top: element.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
  }

  return {
    scrollRef,
    contentRef,
    awayFromLatest,
    onScroll,
    prepareForOlderMessages,
    scrollToLatest,
  };
}
