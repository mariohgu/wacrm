"use client";

import { useEffect } from "react";

/**
 * Mirrors the unread-conversations count onto the app icon via the
 * Badging API (`navigator.setAppBadge`) while the app is open. The
 * service worker sets the same number from each push while the app is
 * closed; together they keep the icon right in both states, and the
 * badge clears the moment the last unread thread is opened.
 *
 * Works on Android (installed or tab) and on iOS 16.4+ for the
 * installed app; elsewhere the API is absent and this is a no-op.
 */
export function useAppBadge(count: number): void {
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const nav = navigator as Navigator & {
      setAppBadge?: (contents?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (typeof nav.setAppBadge !== "function") return;

    const run =
      count > 0
        ? nav.setAppBadge(count)
        : typeof nav.clearAppBadge === "function"
          ? nav.clearAppBadge()
          : nav.setAppBadge(0);
    // The API rejects in contexts that don't support badges (some
    // browsers expose it but refuse in a tab). Nothing to do about it.
    run.catch(() => undefined);
  }, [count]);
}
