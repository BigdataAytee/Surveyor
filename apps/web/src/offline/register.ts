/**
 * Turning the offline shell on.
 *
 * Only in a built app. In development the dev server rewrites modules on every
 * save, and a worker caching them would serve yesterday's code back — the
 * classic "why is my change not appearing" hour.
 *
 * Registration is deliberately quiet and deliberately late. It is not a
 * feature anyone asked for by name; it is the difference between the app
 * opening on a site with no signal and not opening at all, and the right time
 * to do that work is after the app the surveyor is waiting for has painted.
 */

export function registerOfflineShell(): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD) return;

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // A registration failure means no offline shell, which is exactly where
      // the app was before this existed. Nothing to tell the user, and nothing
      // that should stop the app loading.
    });
  });
}
