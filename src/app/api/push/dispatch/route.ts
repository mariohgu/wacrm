import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/contacts/admin-client'
import { loadPushCopy } from '@/lib/push/copy'
import { countUnreadConversations, isPushConfigured, sendPushToUsers } from '@/lib/push/send'

/**
 * POST /api/push/dispatch  — called by Supabase, not by a user.
 *
 * Target of a Supabase **Database Webhook** on `notifications` INSERT.
 * In-app notifications are created by database triggers (e.g.
 * `notify_conversation_assigned`, migration 027), which the app never
 * sees — this hook is how each of them also becomes a push to the
 * recipient's devices. Any notification type added later is push-
 * capable for free.
 *
 * One-time setup in the Supabase dashboard → Database → Webhooks:
 *   Table: notifications · Events: Insert · Type: HTTP Request
 *   URL: https://<your-app>/api/push/dispatch
 *   HTTP Headers: x-push-secret: <the value of PUSH_DISPATCH_SECRET>
 * The secret is compared in constant time; a missing env var disables
 * the endpoint (503) rather than leaving it open.
 *
 * Payload shape (Supabase's): { type: "INSERT", table, schema, record }.
 */
export async function POST(request: Request) {
  const secret = process.env.PUSH_DISPATCH_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'PUSH_DISPATCH_SECRET is not set' }, { status: 503 })
  }
  if (!safeEqual(request.headers.get('x-push-secret') ?? '', secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body || body.type !== 'INSERT' || body.table !== 'notifications' || !body.record) {
    return NextResponse.json({ error: 'Expected a notifications INSERT event' }, { status: 400 })
  }
  const record = body.record as {
    id?: string
    account_id?: string
    user_id?: string
    title?: string
    body?: string | null
    conversation_id?: string | null
  }
  if (!record.id || !record.account_id || !record.user_id) {
    return NextResponse.json({ error: 'record is missing id/account_id/user_id' }, { status: 400 })
  }

  if (!isPushConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'not_configured' })
  }

  const db = supabaseAdmin()
  const copy = await loadPushCopy()
  const badge = await countUnreadConversations(db, record.account_id)
  const result = await sendPushToUsers(db, {
    accountId: record.account_id,
    userIds: [record.user_id],
    payload: {
      type: 'assigned',
      title: record.title?.trim() || copy.assignedTitle || 'MlennyChatBot',
      body: record.body?.trim() ?? '',
      url: record.conversation_id ? `/inbox?c=${record.conversation_id}` : '/notifications',
      tag: `notification-${record.id}`,
      badge,
    },
  })
  return NextResponse.json({ ok: true, ...result })
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
