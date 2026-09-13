import webpush from 'web-push'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Server-side Web Push delivery.
 *
 * One entry point, `sendPushToUsers`, fans a payload out to every
 * subscription the given users have registered (see migration 040 —
 * one row per device). It never throws: a push problem must not break
 * the caller, which is the WhatsApp webhook or a notification hook.
 * Subscriptions the push service reports as gone (404/410) are deleted
 * on the spot so the table doesn't accumulate dead devices.
 *
 * Configuration is three env vars (see .env.local.example):
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY — also shipped to the browser, which
 *     subscribes against it
 *   VAPID_PRIVATE_KEY             — server only
 *   VAPID_SUBJECT                 — a mailto: or https: URL identifying
 *     the sender to the push services (Apple requires a real contact)
 * Generate the key pair once with `npx web-push generate-vapid-keys`.
 * When the keys are absent the feature is simply off: `isPushConfigured`
 * is false, `sendPushToUsers` returns zeros, and the Settings panel
 * says so.
 */

export type PushNotificationType =
  | 'new_message'
  | 'bot_replied'
  | 'needs_attention'
  | 'assigned'
  | 'test'

/** The JSON body the service worker's `push` handler receives. */
export interface PushPayload {
  type: PushNotificationType
  title: string
  body: string
  /** In-app URL opened on tap (`/inbox?c=<id>` for a conversation). */
  url: string
  /**
   * Notification collapse key. One per conversation, so a chatty
   * customer replaces their previous notification instead of stacking
   * a new one per message — which also keeps iOS from counting each
   * one as "ignored" (three ignored in a row revokes the permission).
   */
  tag: string
  /**
   * Account-wide count of conversations with unread customer messages,
   * shown on the app icon via the Badging API. Sent with every push so
   * the icon is right even when the notification itself is swallowed.
   */
  badge?: number
  /**
   * The customer wrote, but the assistant (or a Flow) already answered.
   * The worker delivers it without sound/vibration and drops it
   * entirely when an app window is visible — the point is the badge
   * and the in-app list, not an interruption.
   */
  quiet?: boolean
}

export function isPushConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
}

export interface PushServerStatus {
  configured: boolean
  publicKeyPresent: boolean
  privateKeyPresent: boolean
  /** web-push refuses to sign unless the subject is a mailto: or https: URL. */
  subject: { present: boolean; valid: boolean; kind: 'mailto' | 'https' | 'invalid' | 'missing' }
  dispatchSecretPresent: boolean
}

/**
 * Presence/format of the server-side configuration, for the Settings
 * diagnostics card. Never echoes a value — only whether each env var
 * is set and, for the subject, whether web-push would accept it.
 */
export function getPushServerStatus(): PushServerStatus {
  const subjectRaw = process.env.VAPID_SUBJECT
  let subject: PushServerStatus['subject']
  if (!subjectRaw) {
    subject = { present: false, valid: false, kind: 'missing' }
  } else {
    let kind: PushServerStatus['subject']['kind'] = 'invalid'
    try {
      const protocol = new URL(subjectRaw).protocol
      if (protocol === 'mailto:') kind = 'mailto'
      else if (protocol === 'https:') kind = 'https'
    } catch {
      kind = 'invalid'
    }
    subject = { present: true, valid: kind !== 'invalid', kind }
  }
  return {
    configured: isPushConfigured(),
    publicKeyPresent: !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    privateKeyPresent: !!process.env.VAPID_PRIVATE_KEY,
    subject,
    dispatchSecretPresent: !!process.env.PUSH_DISPATCH_SECRET,
  }
}

let vapidReady = false
function ensureVapid(): boolean {
  if (vapidReady) return true
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) return false
  // web-push insists on a contact; fall back to a placeholder rather
  // than refusing to send, but self-hosters should set a real one —
  // Apple's push service may reject an unreachable subject.
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com'
  webpush.setVapidDetails(subject, publicKey, privateKey)
  vapidReady = true
  return true
}

interface SubscriptionRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushSendResult {
  /** Subscriptions the push service accepted the message for. */
  sent: number
  /** Subscriptions that errored for a reason other than "gone". */
  failed: number
  /** Dead subscriptions (404/410) deleted as a side effect. */
  pruned: number
}

const EMPTY: PushSendResult = { sent: 0, failed: 0, pruned: 0 }

/**
 * Conversations in the account with at least one unread customer
 * message — the same number the in-app sidebar dot is based on. This
 * is what the app icon badge shows. Counts the AI-answered ones too:
 * "unread" means unread by a human, and the point of the badge is to
 * tell the team a customer wrote even when the bot is talking.
 */
export async function countUnreadConversations(
  db: SupabaseClient,
  accountId: string,
): Promise<number> {
  const { count, error } = await db
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gt('unread_count', 0)
  if (error) {
    console.error('[push] unread count failed:', error.message)
    return 0
  }
  return count ?? 0
}

/**
 * Push `payload` to every registered device of `userIds` within
 * `accountId`. Resolves with counts; never rejects.
 */
export async function sendPushToUsers(
  db: SupabaseClient,
  args: { accountId: string; userIds: string[]; payload: PushPayload },
): Promise<PushSendResult> {
  const userIds = [...new Set(args.userIds.filter(Boolean))]
  if (userIds.length === 0 || !ensureVapid()) return { ...EMPTY }

  const result: PushSendResult = { ...EMPTY }
  try {
    const { data, error } = await db
      .from('push_subscriptions')
      .select('id, user_id, endpoint, p256dh, auth')
      .eq('account_id', args.accountId)
      .in('user_id', userIds)
    if (error) {
      console.error('[push] subscription load failed:', error.message)
      return result
    }

    const rows = (data ?? []) as SubscriptionRow[]
    if (rows.length === 0) {
      // The most common "nothing arrived": nobody on the recipient list
      // has enabled push on any device yet.
      console.warn(
        `[push] no subscriptions: account=${args.accountId} recipients=${userIds.length} type=${args.payload.type}`,
      )
      return result
    }

    const body = JSON.stringify(args.payload)
    const stale: string[] = []

    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            body,
            {
              // An hour: a "customer wrote" push is useless after that,
              // and the badge count it carries would be stale anyway.
              TTL: 60 * 60,
              // Quiet (bot-handled) pushes may be batched by the
              // device's battery saver; the ones a human must act on
              // should not be.
              urgency: args.payload.quiet ? 'normal' : 'high',
            },
          )
          result.sent += 1
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) {
            stale.push(row.id)
          } else {
            result.failed += 1
            console.warn(
              `[push] send failed (${status ?? 'network'}) for user ${row.user_id}:`,
              (err as Error).message,
            )
          }
        }
      }),
    )

    if (stale.length > 0) {
      const { error: deleteError } = await db
        .from('push_subscriptions')
        .delete()
        .in('id', stale)
      if (deleteError) {
        console.warn('[push] stale subscription cleanup failed:', deleteError.message)
      } else {
        result.pruned = stale.length
      }
    }
    console.log(
      `[push] delivered: account=${args.accountId} type=${args.payload.type} recipients=${userIds.length} subscriptions=${rows.length} sent=${result.sent} failed=${result.failed} pruned=${result.pruned}`,
    )
  } catch (err) {
    console.error('[push] unexpected failure:', err)
  }
  return result
}
