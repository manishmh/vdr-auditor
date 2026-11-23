"use client";

import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";

/**
 * Disables navigation links while a route change is in flight, so impatient
 * clicks on a slow page cannot stack multiple navigations. The ref guard is
 * synchronous, so even same-frame double clicks are stopped. A safety timer
 * re-arms the links if a navigation silently fails; a successful navigation
 * unmounts the page and discards the state.
 */
export function useNavBusy(safetyMs: number = 8000): {
  navBusy: boolean;
  guardNav: (event: SyntheticEvent) => void;
} {
  const [navBusy, setNavBusy] = useState(false);
  const busyRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const guardNav = useCallback(
    (event: SyntheticEvent) => {
      if (busyRef.current) {
        event.preventDefault();
        return;
      }
      busyRef.current = true;
      setNavBusy(true);
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => {
        timer.current = null;
        busyRef.current = false;
        setNavBusy(false);
      }, safetyMs);
    },
    [safetyMs],
  );

  return { navBusy, guardNav };
}
