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
 * Web Push (`push` / `notificationclick` handlers) is the next phase
 * and belongs in this file when it lands.
 */

const VERSION = "v1";
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
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
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
