import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * Runs the real public/sw.js inside a sandbox that stands in for the
 * service-worker global scope, then dispatches synthetic events at the
 * handlers it registered. What this pins down is the worker's routing
 * contract — which requests it touches, which it leaves alone, and
 * what it answers when the network is gone — the part that would
 * silently break the app if it drifted (e.g. an HTML page getting
 * cached, or /api/* being intercepted). Browser-level behaviour
 * (install lifecycle timing, the update toast) is out of scope here.
 */

const ORIGIN = "https://app.test";
const SW_SOURCE = readFileSync(path.join(process.cwd(), "public", "sw.js"), "utf8");

type Handler = (event: unknown) => void;

/** Resolves the relative URLs the worker uses (`/offline`) the way a
 *  real worker would — against its own origin. */
function absolute(input: string | { url: string }): string {
  const url = typeof input === "string" ? input : input.url;
  return url.startsWith("/") ? ORIGIN + url : url;
}

class FakeCache {
  entries = new Map<string, Response>();
  async match(key: string | { url: string }) {
    return this.entries.get(absolute(key));
  }
  async put(key: string | { url: string }, response: Response) {
    this.entries.set(absolute(key), response);
  }
  async add(request: { url: string }) {
    const response = await sandbox.fetch(request);
    if (!response.ok) throw new Error(`add failed: ${response.status}`);
    this.entries.set(absolute(request), response);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(key: string | { url: string }) {
    return this.entries.delete(absolute(key));
  }
}

class FakeCacheStorage {
  stores = new Map<string, FakeCache>();
  async open(name: string) {
    let store = this.stores.get(name);
    if (!store) {
      store = new FakeCache();
      this.stores.set(name, store);
    }
    return store;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  async match(key: string, opts?: { cacheName?: string }) {
    if (opts?.cacheName) return this.stores.get(opts.cacheName)?.match(key);
    for (const store of this.stores.values()) {
      const hit = await store.match(key);
      if (hit) return hit;
    }
    return undefined;
  }
}

/** Node's Request rejects relative URLs and some RequestInit fields a
 *  worker legitimately uses (`cache: "reload"`); this shim keeps what
 *  the tests need to observe and stays constructible. */
class SandboxRequest {
  url: string;
  method: string;
  mode: string;
  cache?: string;
  constructor(input: string | SandboxRequest, init: RequestInit = {}) {
    this.url = absolute(typeof input === "string" ? input : input.url);
    this.method = init.method ?? "GET";
    this.mode = (init as { mode?: string }).mode ?? "cors";
    this.cache = init.cache;
  }
}

interface FakeWindowClient {
  visibilityState: "visible" | "hidden";
  focus: Mock<() => Promise<void>>;
  navigate: Mock<(url: string) => Promise<void>>;
  postMessage: Mock<(message: unknown) => void>;
}

function windowClient(visibilityState: "visible" | "hidden"): FakeWindowClient {
  return {
    visibilityState,
    focus: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    postMessage: vi.fn(),
  };
}

interface Sandbox {
  self: Sandbox;
  addEventListener: (type: string, handler: Handler) => void;
  caches: FakeCacheStorage;
  fetch: Mock<(request: unknown) => Promise<Response>>;
  clients: {
    claim: Mock<() => Promise<undefined>>;
    matchAll: Mock<(query?: unknown) => Promise<FakeWindowClient[]>>;
    openWindow: Mock<(url: string) => Promise<null>>;
  };
  skipWaiting: Mock<() => Promise<undefined>>;
  registration: {
    showNotification: Mock<(title: string, options: NotificationOptions) => Promise<void>>;
  };
  navigator: {
    setAppBadge: Mock<(count: number) => Promise<void>>;
    clearAppBadge: Mock<() => Promise<void>>;
  };
  location: { origin: string };
  Request: typeof SandboxRequest;
  Response: typeof Response;
  URL: typeof URL;
  console: Console;
  handlers: Record<string, Handler>;
}

let sandbox: Sandbox;

function boot() {
  const handlers: Record<string, Handler> = {};
  const box = {
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    caches: new FakeCacheStorage(),
    fetch: vi.fn(),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => []),
      openWindow: vi.fn(async () => null),
    },
    skipWaiting: vi.fn(async () => undefined),
    registration: { showNotification: vi.fn(async () => undefined) },
    navigator: {
      setAppBadge: vi.fn(async () => undefined),
      clearAppBadge: vi.fn(async () => undefined),
    },
    location: { origin: ORIGIN },
    Request: SandboxRequest,
    Response,
    URL,
    console,
    handlers,
  } as unknown as Sandbox;
  box.self = box;
  vm.runInNewContext(SW_SOURCE, box, { filename: "public/sw.js" });
  return box;
}

/** Fires an extendable event and awaits whatever the handler passed to
 *  waitUntil, resolving to `true` if it settled without rejecting. */
async function dispatchExtendable(type: string, extra: object = {}) {
  let pending: Promise<unknown> = Promise.resolve();
  sandbox.handlers[type]({ ...extra, waitUntil: (p: Promise<unknown>) => (pending = p) });
  try {
    await pending;
    return true;
  } catch {
    return false;
  }
}

/** Fires a fetch event; returns the promised response the worker
 *  passed to respondWith, or `null` if it declined to handle it. */
async function dispatchFetch(request: Partial<SandboxRequest>) {
  // `null as …` keeps the union: a plain `= null` initialiser would let
  // TS narrow the variable to `null`, blind to the closure assignment.
  let response = null as Promise<Response> | null;
  sandbox.handlers.fetch({
    request: { method: "GET", mode: "cors", ...request },
    respondWith: (p: Promise<Response>) => (response = p),
  });
  return response ? await response : null;
}

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/html" }, ...init });

beforeEach(() => {
  sandbox = boot();
});

describe("sw.js — registers the expected handlers", () => {
  it("listens for install, activate, message, fetch and the three push events", () => {
    expect(Object.keys(sandbox.handlers).sort()).toEqual(
      ["activate", "fetch", "install", "message", "notificationclick", "push", "pushsubscriptionchange"],
    );
  });
});

describe("sw.js — install", () => {
  it("precaches /offline, bypassing the HTTP cache", async () => {
    sandbox.fetch.mockResolvedValue(html("<h1>Sin conexión</h1>"));
    expect(await dispatchExtendable("install")).toBe(true);

    const [request] = sandbox.fetch.mock.calls[0] as [SandboxRequest];
    expect(request.url).toBe(`${ORIGIN}/offline`);
    expect(request.cache).toBe("reload");
    const cached = await sandbox.caches.match("/offline", { cacheName: "mlenny-offline-v2" });
    expect(cached).toBeDefined();
  });

  it("still installs when the precache fails", async () => {
    sandbox.fetch.mockRejectedValue(new TypeError("network down"));
    expect(await dispatchExtendable("install")).toBe(true);
  });
});

describe("sw.js — activate", () => {
  it("drops stale mlenny-* caches, keeps the current ones and foreign ones, then claims clients", async () => {
    await sandbox.caches.open("mlenny-static-v0");
    await sandbox.caches.open("mlenny-offline-v0");
    await sandbox.caches.open("mlenny-static-v2");
    await sandbox.caches.open("mlenny-offline-v2");
    await sandbox.caches.open("someone-elses-cache");

    expect(await dispatchExtendable("activate")).toBe(true);

    expect((await sandbox.caches.keys()).sort()).toEqual(
      ["mlenny-offline-v2", "mlenny-static-v2", "someone-elses-cache"],
    );
    expect(sandbox.clients.claim).toHaveBeenCalledTimes(1);
  });
});

describe("sw.js — message", () => {
  it("skips waiting only for SKIP_WAITING", () => {
    sandbox.handlers.message({ data: { type: "SOMETHING_ELSE" } });
    sandbox.handlers.message({ data: null });
    expect(sandbox.skipWaiting).not.toHaveBeenCalled();

    sandbox.handlers.message({ data: { type: "SKIP_WAITING" } });
    expect(sandbox.skipWaiting).toHaveBeenCalledTimes(1);
  });
});

describe("sw.js — fetch: what it leaves alone", () => {
  it.each([
    ["a POST", { method: "POST", url: `${ORIGIN}/api/whatsapp/send` }],
    ["a cross-origin GET", { url: "https://xyz.supabase.co/rest/v1/messages" }],
    ["a same-origin API GET", { url: `${ORIGIN}/api/ai/config` }],
    ["a same-origin media/proxy GET", { url: `${ORIGIN}/api/whatsapp/media/abc` }],
    ["an icon", { url: `${ORIGIN}/icons/icon-192.png` }],
    ["a non-static Next asset", { url: `${ORIGIN}/_next/image?url=x` }],
  ])("does not intercept %s", async (_label, request) => {
    expect(await dispatchFetch(request)).toBeNull();
    expect(sandbox.fetch).not.toHaveBeenCalled();
  });
});

describe("sw.js — fetch: navigations are network-first", () => {
  const nav = { url: `${ORIGIN}/inbox?c=123`, mode: "navigate" };

  it("passes the network response through, including server errors, and never caches HTML", async () => {
    const serverError = html("<h1>500</h1>", { status: 500 });
    sandbox.fetch.mockResolvedValue(serverError);

    expect(await dispatchFetch(nav)).toBe(serverError);
    for (const store of sandbox.caches.stores.values()) {
      expect(store.entries.has(`${ORIGIN}/inbox?c=123`)).toBe(false);
    }
  });

  it("serves the precached /offline page when the network throws", async () => {
    const offline = html("<h1>Sin conexión</h1>");
    (await sandbox.caches.open("mlenny-offline-v2")).entries.set(`${ORIGIN}/offline`, offline);
    sandbox.fetch.mockRejectedValue(new TypeError("Failed to fetch"));

    expect(await dispatchFetch(nav)).toBe(offline);
  });

  it("falls back to an inline 503 page when /offline was never precached", async () => {
    sandbox.fetch.mockRejectedValue(new TypeError("Failed to fetch"));

    const response = (await dispatchFetch(nav)) as Response;
    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(await response.text()).toContain("Sin conexión");
  });
});

describe("sw.js — fetch: /_next/static is cache-first", () => {
  const chunk = { url: `${ORIGIN}/_next/static/chunks/app-abc123.js` };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("fetches once, then answers from cache without touching the network", async () => {
    sandbox.fetch.mockResolvedValue(new Response("console.log(1)", { status: 200 }));

    const first = (await dispatchFetch(chunk)) as Response;
    expect(await first.text()).toBe("console.log(1)");
    expect(sandbox.fetch).toHaveBeenCalledTimes(1);
    await flush();

    sandbox.fetch.mockClear();
    const second = (await dispatchFetch(chunk)) as Response;
    expect(await second.text()).toBe("console.log(1)");
    expect(sandbox.fetch).not.toHaveBeenCalled();
  });

  it("does not cache a non-2xx response", async () => {
    sandbox.fetch.mockResolvedValue(new Response("nope", { status: 404 }));
    await dispatchFetch(chunk);
    await flush();

    const store = await sandbox.caches.open("mlenny-static-v2");
    expect(store.entries.size).toBe(0);
  });

  it("evicts the oldest entries past the cap", async () => {
    sandbox.fetch.mockImplementation(async () => new Response("x", { status: 200 }));
    for (let i = 0; i < 205; i++) {
      await dispatchFetch({ url: `${ORIGIN}/_next/static/chunks/c${i}.js` });
      await flush();
    }
    const store = await sandbox.caches.open("mlenny-static-v2");
    expect(store.entries.size).toBe(200);
    expect(store.entries.has(`${ORIGIN}/_next/static/chunks/c0.js`)).toBe(false);
    expect(store.entries.has(`${ORIGIN}/_next/static/chunks/c204.js`)).toBe(true);
  });
});

// ---- Web Push ----------------------------------------------------------

/** A push event carrying a JSON payload, as the browser would build it. */
const pushEvent = (payload: unknown) => ({
  data: { json: () => payload, text: () => JSON.stringify(payload) },
});

describe("sw.js — push", () => {
  const loud = {
    type: "needs_attention",
    title: "Ana necesita a una persona",
    body: "El asistente derivó esta conversación.",
    url: "/inbox?c=conv-1",
    tag: "conv-conv-1",
    badge: 3,
  };
  const quiet = { ...loud, type: "bot_replied", title: "Ana · respondió el asistente", quiet: true };

  it("sets the app badge from the payload and clears it at zero", async () => {
    await dispatchExtendable("push", pushEvent({ ...loud, badge: 3 }));
    expect(sandbox.navigator.setAppBadge).toHaveBeenCalledWith(3);

    await dispatchExtendable("push", pushEvent({ ...loud, badge: 0 }));
    expect(sandbox.navigator.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("shows a notification with tag, url and icons when no app window is visible", async () => {
    sandbox.clients.matchAll.mockResolvedValue([windowClient("hidden")]);
    await dispatchExtendable("push", pushEvent(loud));

    expect(sandbox.registration.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = sandbox.registration.showNotification.mock.calls[0];
    expect(title).toBe(loud.title);
    expect(options).toMatchObject({
      body: loud.body,
      tag: loud.tag,
      silent: false,
      renotify: true,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url: loud.url },
    });
  });

  it("delivers a quiet push silently, and drops it entirely when the app is visible", async () => {
    await dispatchExtendable("push", pushEvent(quiet));
    expect(sandbox.registration.showNotification.mock.calls[0][1]).toMatchObject({
      silent: true,
      renotify: false,
    });

    sandbox.registration.showNotification.mockClear();
    const visible = windowClient("visible");
    sandbox.clients.matchAll.mockResolvedValue([visible]);
    await dispatchExtendable("push", pushEvent(quiet));

    expect(sandbox.registration.showNotification).not.toHaveBeenCalled();
    expect(visible.postMessage).toHaveBeenCalledWith({ type: "PUSH_RECEIVED", payload: quiet });
    // The badge still updates — that is the whole point of a quiet push.
    expect(sandbox.navigator.setAppBadge).toHaveBeenLastCalledWith(3);
  });

  it("still shows a loud push when the app is visible (it must make a sound)", async () => {
    sandbox.clients.matchAll.mockResolvedValue([windowClient("visible")]);
    await dispatchExtendable("push", pushEvent(loud));
    expect(sandbox.registration.showNotification).toHaveBeenCalledTimes(1);
  });

  it("survives a non-JSON payload by showing a generic notification", async () => {
    await dispatchExtendable("push", {
      data: {
        json: () => {
          throw new SyntaxError("not json");
        },
        text: () => "plain text",
      },
    });
    const [title, options] = sandbox.registration.showNotification.mock.calls[0];
    expect(title).toBe("MlennyChatBot");
    expect(options).toMatchObject({ body: "plain text", data: { url: "/inbox" } });
  });
});

describe("sw.js — notificationclick", () => {
  const click = (url: string | undefined) => ({
    notification: { close: vi.fn(), data: url ? { url } : undefined },
  });

  it("focuses an existing app window and navigates it to the conversation", async () => {
    const existing = windowClient("hidden");
    sandbox.clients.matchAll.mockResolvedValue([existing]);

    await dispatchExtendable("notificationclick", click("/inbox?c=conv-1"));

    expect(existing.focus).toHaveBeenCalledTimes(1);
    expect(existing.navigate).toHaveBeenCalledWith(`${ORIGIN}/inbox?c=conv-1`);
    expect(sandbox.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens a new window when the app is closed, defaulting to the inbox", async () => {
    await dispatchExtendable("notificationclick", click(undefined));
    expect(sandbox.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/inbox`);
  });
});

