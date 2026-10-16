import { useCallback, useEffect, useRef, useState } from "react";
import type { DefaultBrowserStatus } from "../../shared/types";
import { bridge } from "./bridge";

const WATCH_MS = 60_000;

/** While enabled: read at once and on window focus, and each second for 60 s after makeDefault(). */
export function useDefaultBrowser(enabled: boolean): {
  status: DefaultBrowserStatus | null;
  makeDefault(): Promise<void>;
} {
  const [status, setStatus] = useState<DefaultBrowserStatus | null>(null);
  const [watchUntil, setWatchUntil] = useState(0);
  const latest = useRef(0);
  // Only the newest read answers, so a slow earlier one never wins.
  const read = useCallback(() => {
    const ticket = ++latest.current;
    void bridge.defaultBrowser().then(
      (value) => {
        if (ticket === latest.current) setStatus(value);
      },
      () => {},
    );
  }, []);
  useEffect(() => {
    if (!enabled) return;
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [enabled, read]);
  useEffect(() => {
    if (!enabled || watchUntil <= Date.now()) return;
    const timer = setInterval(() => {
      read();
      if (Date.now() >= watchUntil) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [enabled, watchUntil, read]);
  const makeDefault = useCallback(async () => {
    try {
      await bridge.makeDefaultBrowser();
    } catch {
      /* The next reads show whether anything changed. */
    }
    setWatchUntil(Date.now() + WATCH_MS);
  }, []);
  return { status, makeDefault };
}
