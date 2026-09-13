/*
 * MlennyChatBot service worker — hand-written, no build step, no
 * library. Registered by src/components/pwa/service-worker-registration.tsx
 * (production only) and served with `Cache-Control: no-cache` by the
 * rule in next.config.ts so a deploy is picked up on the next visit.
 *
 * Scope of what it does, deliberately small:
 *   1. Navigations (page loads) go network-first. If the network is
 *      down, the precached /offline page is served instead of the
 *      browser's own error screen. HTML is never cached — every page
 *      behind the sign-in is personalised, and the CDN already handles
 *      short-term caching for the rest.
 *   2. /_next/static/* (content-hashed JS/CSS/fonts) is cache-first —
 *      those URLs change whenever their content does, so a cached copy
 *      is always correct. Capped so the cache can't grow forever across
 *      deploys.
 *   3. Everything else — /api/*, Supabase, media, icons — is not
 *      intercepted at all; the request goes to the network exactly as
 *      it would without a worker.
 *
 * Updates: a new worker installs in the background and WAITS (no
 * skipWaiting at install) so the app can show a "new version" toast;
 * the toast's button posts SKIP_WAITING, the worker activates, the
 * page sees `controllerchange` and reloads. Bump VERSION whenever the
 * caching logic here changes so old caches get dropped on activate.
 *
 * Web Push: `push` updates the app-icon badge and shows (or quietly
 * replaces) a notification — payload shape: PushPayload in
 * src/lib/push/send.ts; `notificationclick` focuses the app on the
 * conversation; `pushsubscriptionchange` re-subscribes silently.
 */

const VERSION = "v2";
const STATIC_CACHE = `mlenny-static-${VERSION}`;
const OFFLINE_CACHE = `mlenny-offline-${VERSION}`;
const OFFLINE_URL = "/offline";
const STATIC_CACHE_MAX_ENTRIES = 200;

// Last-resort body if /offline could not be precached (e.g. the first
// install happened while the server was mid-deploy). Plain HTML, no
// assets, so it renders under any conditions.
const FALLBACK_HTML =
  '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>MlennyChatBot</title>" +
  "<style>body{margin:0;min-height:100vh;display:flex;align-items:center;" +
  "justify-content:center;background:#05070b;color:#fafafa;" +
  "font-family:system-ui,sans-serif;text-align:center;padding:24px}" +
  "p{color:#9aa1ad}</style></head><body><div><h1>Sin conexión</h1>" +
  "<p>Revisa tu red e inténtalo de nuevo.</p></div></body></html>";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      // `cache: "reload"` bypasses the HTTP cache so the precached
      // copy is the one the server is serving right now.
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      // A failed precache must not block installation — the worker is
      // still useful for static assets and for the update flow, and
      // FALLBACK_HTML covers the offline case.
      .catch(() => {}),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC_CACHE, OFFLINE_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("mlenny-") && !keep.has(name))
          .map((name) => caches.delete(name)),
      );
      // Take control of already-open tabs without waiting for a reload.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  // Diagnostics: the Settings panel asks the ACTIVE worker its version
  // to detect a stale build still in control (one without a push
  // handler stays silent when a push arrives). Reply over the port the
  // page sent, falling back to the client itself.
  if (data.type === "GET_VERSION") {
    const reply = { type: "VERSION", version: VERSION };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if (event.source && typeof event.source.postMessage === "function") event.source.postMessage(reply);
  }
});

// ---- Web Push --------------------------------------------------------

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not JSON (a bare-text test push from a dashboard, say) — still
    // surface it rather than swallow it.
    data = { title: "MlennyChatBot", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(handlePush(data));
});

async function handlePush(data) {
  // The app-icon badge is refreshed on EVERY push, quiet or not: it is
  // the "a customer wrote" signal the team wants even while the
  // assistant is the one answering.
  await setBadge(data.badge);

  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const visible = windows.find((client) => client.visibilityState === "visible");
  if (visible) {
    // The open app already shows the message through realtime. Tell it
    // anyway (anything listening can react), and for a quiet push stop
    // here — no banner over a screen that already shows the thread.
    // Loud pushes (a human must act) are still shown so they make a
    // sound even with the app in front.
    visible.postMessage({ type: "PUSH_RECEIVED", payload: data });
    if (data.quiet) return;
  }

  await self.registration.showNotification(data.title || "MlennyChatBot", {
    body: data.body || "",
    // Same conversation → the new notification replaces the previous
    // one instead of stacking; renotify only when it is worth a sound.
    tag: data.tag || undefined,
    renotify: !!data.tag && !data.quiet,
    silent: !!data.quiet,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    data: { url: data.url || "/inbox" },
  });
}

async function setBadge(count) {
  if (typeof count !== "number") return;
  const nav = self.navigator;
  if (!nav || typeof nav.setAppBadge !== "function") return;
  try {
    if (count > 0) await nav.setAppBadge(count);
    else if (typeof nav.clearAppBadge === "function") await nav.clearAppBadge();
    else await nav.setAppBadge(0);
  } catch {
    // Badging refused in this context — nothing to do.
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/inbox";
  event.waitUntil(openOrFocus(url));
});

async function openOrFocus(url) {
  const target = new URL(url, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if ("focus" in client) {
      try {
        await client.focus();
        if ("navigate" in client) await client.navigate(target);
        return;
      } catch {
        // Fall through to opening a fresh window.
      }
    }
  }
  await self.clients.openWindow(target);
}

// The push service rotated this browser's subscription (rare, but it
// happens). Re-subscribe with the same key and tell the server, so the
// device keeps receiving without the user touching Settings again.
self.addEventListener("pushsubscriptionchange", (event) => {
  const oldKey =
    event.oldSubscription &&
    event.oldSubscription.options &&
    event.oldSubscription.options.applicationServerKey;
  if (!oldKey) return;
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: oldKey })
      .then((subscription) =>
        fetch("/api/push/subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(subscription.toJSON()),
        }),
      )
      .catch(() => {}),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Anything else falls through to the network untouched.
});

async function networkFirstNavigation(request) {
  try {
    // A server-side error (5xx) is a real response and is passed
    // through as-is — it says more than a generic offline screen would.
    return await fetch(request);
  } catch {
    const cached = await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE });
    if (cached) return cached;
    return new Response(FALLBACK_HTML, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) {
    // Store a clone, then trim oldest-first. Fire-and-forget: the
    // response goes back to the page immediately either way.
    cache
      .put(request, response.clone())
      .then(() => trimCache(cache, STATIC_CACHE_MAX_ENTRIES))
      .catch(() => {});
  }
  return response;
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  // cache.keys() returns entries in insertion order, so the head of
  // the list is the oldest.
  const excess = keys.slice(0, keys.length - maxEntries);
  await Promise.all(excess.map((key) => cache.delete(key)));
}
