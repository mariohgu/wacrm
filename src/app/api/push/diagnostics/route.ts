import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/contacts/admin-client'
import { loadPushCopy } from '@/lib/push/copy'
import { countUnreadConversations, getPushServerStatus } from '@/lib/push/send'

/**
 * GET /api/push/diagnostics  (any signed-in member)
 *
 * Everything the Settings → Push notifications "Diagnostics" card
 * needs to explain why a push did or didn't arrive, without server
 * log access: is the server configured (no secrets echoed — presence
 * and format only), did the copy load, which devices of the caller
 * are registered, and account-level numbers (members, subscribed
 * devices, unread conversations = the badge count that would be sent).
 *
 * Endpoints are push-service URLs; they are reported as host + the
 * last 12 characters — enough for the browser to recognise its own
 * subscription, not enough to reuse.
 */
export async function GET() {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()
    const db = supabaseAdmin()

    const server = getPushServerStatus()

    let copy: { ok: boolean; locale: string; keys: number; error?: string }
    try {
      const loaded = await loadPushCopy()
      copy = {
        ok: Object.keys(loaded).length > 0,
        locale: process.env.NEXT_PUBLIC_APP_LOCALE || 'en',
        keys: Object.keys(loaded).length,
      }
    } catch (err) {
      copy = {
        ok: false,
        locale: process.env.NEXT_PUBLIC_APP_LOCALE || 'en',
        keys: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    // Own devices, through the RLS client (own rows only).
    const { data: ownRows, error: ownError } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, user_agent, created_at, last_seen_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    const [{ count: members }, { count: accountDevices }, unreadConversations] =
      await Promise.all([
        db.from('profiles').select('user_id', { count: 'exact', head: true }).eq('account_id', accountId),
        db.from('push_subscriptions').select('id', { count: 'exact', head: true }).eq('account_id', accountId),
        countUnreadConversations(db, accountId),
      ])

    const devices = ((ownRows ?? []) as {
      id: string
      endpoint: string
      user_agent: string | null
      created_at: string
      last_seen_at: string
    }[]).map((row) => {
      let host = 'unknown'
      try {
        host = new URL(row.endpoint).host
      } catch {
        // leave as unknown
      }
      return {
        id: row.id,
        host,
        endpointSuffix: row.endpoint.slice(-12),
        userAgent: row.user_agent,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
      }
    })

    return NextResponse.json({
      checkedAt: new Date().toISOString(),
      server,
      copy,
      account: {
        members: members ?? 0,
        subscribedDevices: accountDevices ?? 0,
        unreadConversations,
      },
      devices,
      devicesError: ownError?.message ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
