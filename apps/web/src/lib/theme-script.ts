// Plain values only (no React): imported by the server layout and the client store.

export type Theme = "light" | "dark";
export const THEME_KEY = "radio-jil:theme";

/** An explicit choice wins; otherwise follow the operating system. */
export function resolveTheme(explicit: string | null | undefined, systemDark: boolean): Theme {
  if (explicit === "light" || explicit === "dark") return explicit;
  return systemDark ? "dark" : "light";
}

/**
 * Runs in <head> before first paint so a saved choice never flashes the other theme.
 * Without a saved choice it does nothing: the CSS media query follows the system.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();`;
