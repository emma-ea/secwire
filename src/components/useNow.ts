"use client";

import { useSyncExternalStore } from "react";

/**
 * Current time, shared by all subscribers and refreshed every 15s.
 * Returns null during SSR and hydration so server and client markup match;
 * the client re-renders with a real Date right after.
 */
const TICK_MS = 15_000;
let current: Date | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    timer = setInterval(() => {
      current = new Date();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const getSnapshot = () => (current ??= new Date());
const getServerSnapshot = () => null;

export function useNow(): Date | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
