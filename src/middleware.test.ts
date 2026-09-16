import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DEFAULT_LANDING_PATH } from "@/lib/navigation";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getClaims() resolves to (a refreshed session ⇒ a
//                      verified `sub`, or null for the logged-out path).
// `claimsCalls`      — how many times the middleware asked auth-js at all
//                      (a router prefetch must never get that far).
// `refreshedCookies` — cookies Supabase writes via setAll() during getClaims(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let claimsCalls = 0;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      // Mirrors real auth-js: getClaims() goes through getSession(), so an
      // expired access token is transparently refreshed, which rotates the
      // refresh token and pushes the new cookies through setAll() before
      // resolving. The middleware must use getClaims (local verification),
      // never getUser (a rate-limited network round trip per request).
      getClaims: async () => {
        claimsCalls += 1;
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return {
          data: mockUser ? { claims: { sub: mockUser.id } } : null,
          error: null,
        };
      },
    },
  }),
}));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  claimsCalls = 0;
  refreshedCookies = [];
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("middleware — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to the default landing route…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(DEFAULT_LANDING_PATH);
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getClaims() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

// Regression guards for the 2026-09-16 incident: the server-side auth
// check ran on every request — router prefetches and API calls
// included — and tripped Supabase's per-IP limit on the auth endpoint
// (`AuthApiError: Request rate limit reached`, 429), which bounced a
// signed-in user to /login. See `src/lib/auth/verified-user.ts`.
describe("middleware — keeps server-side auth traffic down", () => {
  it("passes a router prefetch straight through without consulting auth", async () => {
    mockUser = null; // even a logged-out prefetch must not hit auth
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/inbox", {
        headers: { "next-router-prefetch": "1" },
      }),
    );

    expect(claimsCalls).toBe(0);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still gates a real navigation to a protected page", async () => {
    mockUser = null;

    const res = await middleware(new NextRequest("https://app.test/inbox"));

    expect(claimsCalls).toBe(1);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("does not match API routes (they authenticate themselves)", async () => {
    const { config } = await import("./middleware");
    // Next compiles the matcher with path-to-regexp; a plain anchored
    // RegExp is a faithful stand-in for this pattern's negative lookahead.
    const matcher = new RegExp(`^${config.matcher[0]}$`);

    expect(matcher.test("/api/whatsapp/send")).toBe(false);
    expect(matcher.test("/api/ai/config")).toBe(false);
    expect(matcher.test("/inbox")).toBe(true);
    expect(matcher.test("/login")).toBe(true);
    expect(matcher.test("/sw.js")).toBe(false);
  });
});
