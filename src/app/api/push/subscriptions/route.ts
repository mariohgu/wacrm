import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * POST   /api/push/subscriptions  (any signed-in member)
 * DELETE /api/push/subscriptions  (any signed-in member)
 *
 * Registers / forgets THIS browser's Web Push subscription for the
 * calling user. The body is the `PushSubscription.toJSON()` shape the
 * browser produces (`endpoint`, `keys.p256dh`, `keys.auth`). Upserts
 * on `endpoint`, which is unique per browser subscription, so
 * re-subscribing after the push service rotates it is a no-op update.
 *
 * Writes go through the caller's RLS-scoped client: the policies in
 * migration 040 pin `user_id` to `auth.uid()` and `account_id` to an
 * account the caller belongs to, so no service role is needed here.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()

    const body = await request.json().catch(() => null)
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : ''
    const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : ''
    const auth = typeof body?.keys?.auth === 'string' ? body.keys.auth : ''
    if (!endpoint.startsWith('https://') || !p256dh || !auth) {
      return NextResponse.json(
        { error: 'Body must be a PushSubscription JSON (endpoint, keys.p256dh, keys.auth)' },
        { status: 400 },
      )
    }

    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        account_id: accountId,
        user_id: userId,
        endpoint,
        p256dh,
        auth,
        user_agent: request.headers.get('user-agent')?.slice(0, 255) ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    )
    if (error) {
      console.error('[push] subscription upsert failed:', error.message)
      return NextResponse.json({ error: 'Could not save subscription' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const { supabase } = await getCurrentAccount()

    const body = await request.json().catch(() => null)
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : ''
    if (!endpoint) {
      return NextResponse.json({ error: 'endpoint is required' }, { status: 400 })
    }

    // RLS restricts the delete to the caller's own rows.
    const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
    if (error) {
      console.error('[push] subscription delete failed:', error.message)
      return NextResponse.json({ error: 'Could not remove subscription' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
