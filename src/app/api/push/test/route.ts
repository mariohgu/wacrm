import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/contacts/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadPushCopy } from '@/lib/push/copy'
import { countUnreadConversations, isPushConfigured, sendPushToUsers } from '@/lib/push/send'

/**
 * POST /api/push/test  (any signed-in member)
 *
 * "Send a test notification" button in Settings → Push notifications.
 * Pushes to every device the *caller* has registered and reports the
 * counts, so the panel can say "sent to 2 devices" or "no device is
 * subscribed" rather than guessing.
 */
export async function POST() {
  try {
    const { accountId, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`push-test:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    if (!isPushConfigured()) {
      return NextResponse.json(
        { error: 'Push is not configured on the server (VAPID keys missing)' },
        { status: 503 },
      )
    }

    const db = supabaseAdmin()
    const copy = await loadPushCopy()
    const badge = await countUnreadConversations(db, accountId)
    const result = await sendPushToUsers(db, {
      accountId,
      userIds: [userId],
      payload: {
        type: 'test',
        title: copy.testTitle ?? 'MlennyChatBot',
        body: copy.testBody ?? 'Push notifications are working on this device.',
        url: '/inbox',
        tag: 'push-test',
        badge,
      },
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return toErrorResponse(err)
  }
}
