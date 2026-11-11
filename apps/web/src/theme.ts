import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';

const key = 'mailisle-theme';
const listeners = new Set<() => void>();

function stored(): Theme {
  // Storage can be unavailable, for example in a private window; the system setting is used then.
  try { const value = localStorage.getItem(key); return value === 'light' || value === 'dark' ? value : 'system'; }
  catch { return 'system'; }
}
let current = stored();

/** The stylesheet follows the system by itself; an explicit choice is an attribute on the root element. */
function apply() {
  if (current === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = current;
}
apply();

export function setTheme(theme: Theme) {
  current = theme;
  try { if (theme === 'system') localStorage.removeItem(key); else localStorage.setItem(key, theme); } catch { /* The choice then lasts for this page only. */ }
  apply();
  for (const listener of listeners) listener();
}

/** The chosen theme, shared by every component that shows the switch. */
export function useTheme() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current);
}
