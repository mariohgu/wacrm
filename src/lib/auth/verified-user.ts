// ============================================================
// Cheap, verified "who is calling" for server code.
//
// `supabase.auth.getUser()` is a network round trip to
// `/auth/v1/user` on EVERY call. Supabase rate-limits that endpoint
// per source IP (30 requests / 5 minutes by default), and when the
// app runs on a host with one egress IP (Hostinger, a VPS, any
// single Node server) every visitor's server-side check counts
// against the same bucket. A single inbox page load — middleware on
// each of ~15 nav-link prefetches plus a handful of API calls — blew
// through it in one second and every request then failed with
// `AuthApiError: Request rate limit reached (429)` and bounced the
// user to /login (2026-09-16, see CLAUDE.md).
//
// `getClaims()` verifies the access token's signature LOCALLY with
// WebCrypto against the project's JWKS (fetched once, cached 10 min
// process-wide) when the project uses asymmetric JWT signing keys
// (ES256/RS256 — Supabase Dashboard → Project Settings → JWT Keys).
// On a project still on the legacy HS256 shared secret it falls back
// to `getUser()` internally, so it is never worse than before.
//
// Either way the session-refresh behaviour is unchanged: with no
// token argument it goes through `getSession()`, which refreshes an
// expired access token (rotating the refresh token and writing the
// new cookies through the SSR client's `setAll`) exactly like
// `getUser()` did.
//
// This module is deliberately dependency-free (no `next/headers`) so
// `src/middleware.ts` (Edge runtime) can import it as well.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

type ClaimsClient = { auth: Pick<SupabaseClient['auth'], 'getClaims'> }

/**
 * Resolve the calling user's id from a verified access token, or
 * `null` when there is no session / the token is invalid or expired
 * beyond refresh. Never throws on auth failures — callers map `null`
 * to 401 / redirect the same way they mapped `getUser()`'s empty
 * result.
 */
export async function getVerifiedUserId(
  supabase: ClaimsClient,
): Promise<string | null> {
  const { data, error } = await supabase.auth.getClaims()
  if (error || !data) return null
  const sub = data.claims.sub
  return typeof sub === 'string' && sub.length > 0 ? sub : null
}
