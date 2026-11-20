import { useSyncExternalStore } from "react";

import { resolveTheme, type Theme, THEME_KEY } from "./theme-script";

export type { Theme };

const listeners = new Set<() => void>();
const DARK_QUERY = "(prefers-color-scheme: dark)";

function current(): Theme {
  return resolveTheme(document.documentElement.dataset.theme, window.matchMedia(DARK_QUERY).matches);
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener("change", fn);
  return () => {
    listeners.delete(fn);
    mq.removeEventListener("change", fn);
  };
}

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // storage blocked: the choice lasts for this visit
  }
  for (const fn of listeners) fn();
}

/** The theme actually showing (explicit choice or system). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, current, () => "light");
}
