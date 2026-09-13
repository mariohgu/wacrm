"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

const SW_URL = "/sw.js";
const UPDATE_TOAST_ID = "pwa-update";

/**
 * Registers public/sw.js and runs the update flow. Headless — renders
 * nothing. Mounted by the dashboard shell once a user is signed in.
 *
 * Production only: in `next dev` a service worker would sit between
 * the page and Turbopack's HMR and make "why isn't my change showing"
 * a daily question. The check is inlined at build time, so the whole
 * effect body is dead code in a dev bundle.
 *
 * Update flow (mirrors the worker's side, see the header of sw.js):
 *   - A new worker installs and waits. When it reaches `installed`
 *     while an older worker still controls the page, we show a
 *     persistent toast with an "Update" action.
 *   - The action posts SKIP_WAITING; the worker activates; the browser
 *     fires `controllerchange`; we reload once so the page runs on the
 *     new build's chunks.
 *   - `controllerchange` also fires on the very FIRST install (the
 *     worker calls clients.claim()). There is nothing to reload into
 *     then — the page already is the current build — so the reload is
 *     gated on there having been a controller before we registered.
 */
export function ServiceWorkerRegistration() {
  const t = useTranslations("Pwa");
  // Read the strings up front so the effect's dependency list holds
  // primitives (stable — one build-time locale) rather than `t`, whose
  // identity next-intl doesn't guarantee across renders.
  const updateAvailable = t("updateAvailable");
  const updateAction = t("updateAction");

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const container = navigator.serviceWorker;
    const hadController = !!container.controller;
    let cancelled = false;
    let reloading = false;

    const promptUpdate = (worker: ServiceWorker) => {
      toast(updateAvailable, {
        id: UPDATE_TOAST_ID,
        duration: Infinity,
        action: {
          label: updateAction,
          onClick: () => worker.postMessage({ type: "SKIP_WAITING" }),
        },
      });
    };

    const onControllerChange = () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    };
    container.addEventListener("controllerchange", onControllerChange);

    container
      // updateViaCache: "none" — always revalidate sw.js against the
      // server (belt and braces with the no-cache header it's served
      // with), so a deploy is noticed on the next navigation.
      .register(SW_URL, { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        if (cancelled) return;

        // A worker that finished installing while no tab was open to
        // hear `updatefound` is already waiting when we arrive.
        if (registration.waiting && container.controller) {
          promptUpdate(registration.waiting);
        }

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && container.controller) {
              promptUpdate(installing);
            }
          });
        });
      })
      .catch((err) => {
        // Not fatal — the app works exactly as before without a worker.
        console.warn("[pwa] service worker registration failed:", err);
      });

    return () => {
      cancelled = true;
      container.removeEventListener("controllerchange", onControllerChange);
    };
  }, [updateAvailable, updateAction]);

  return null;
}
