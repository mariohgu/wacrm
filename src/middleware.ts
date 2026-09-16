import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { DEFAULT_LANDING_PATH } from '@/lib/navigation'
import { getVerifiedUserId } from '@/lib/auth/verified-user'

/**
 * Next's client router prefetches the RSC payload of every `<Link>`
 * that scrolls into view (the sidebar + bottom tab bar alone are ~15
 * links) and each prefetch is a full request through this middleware.
 * Those payloads carry no user data — every dashboard page is a client
 * component that loads its data under RLS after mount, and the shell
 * itself redirects to /login when there is no session — so there is
 * nothing to gate here, and gating them was what pushed the
 * server-side auth check over Supabase's per-IP rate limit (see
 * `src/lib/auth/verified-user.ts`). Real navigations (the click, a
 * reload, a deep link) never carry these headers and are still checked.
 */
function isRouterPrefetch(request: NextRequest): boolean {
  return (
    request.headers.get('next-router-prefetch') === '1' ||
    request.headers.get('purpose') === 'prefetch' ||
    request.headers.get('sec-purpose')?.includes('prefetch') === true
  )
}

export async function middleware(request: NextRequest) {
  if (isRouterPrefetch(request)) {
    return NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Local JWT verification (no `/auth/v1/user` round trip on a project
  // with asymmetric signing keys) — see `getVerifiedUserId`.
  const userId = await getVerifiedUserId(supabase)

  // Resolving the session transparently refreshes an expired access
  // token, which ROTATES the refresh token and writes the new cookies
  // onto `supabaseResponse` via setAll() above. Any response we return
  // in place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (userId && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = DEFAULT_LANDING_PATH
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!userId && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    // - `api/` is excluded on purpose: every route handler authenticates
    //   itself (`requireRole` / `getCurrentAccount` / `getVerifiedUserId`
    //   for the dashboard routes, `requireApiKey` for `/api/v1`, shared
    //   secrets for the cron + push-dispatch routes, Meta's signature for
    //   the webhook), and running the session check here as well doubled
    //   the auth traffic of every API call for no extra protection. A
    //   route handler can also write refreshed session cookies itself, so
    //   nothing is lost on that side either.
    // - manifest.webmanifest and sw.js are fetched by the browser's PWA
    //   machinery, not by a signed-in page — no auth to check.
    '/((?!api/|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|.*\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
