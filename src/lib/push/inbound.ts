import type { SupabaseClient } from '@supabase/supabase-js'
import type { AutoReplyAttempt } from '@/lib/ai/auto-reply'
import { looksLikePhoneNumber } from '@/lib/whatsapp/phone-utils'
import { fill, loadPushCopy, preview } from './copy'
import {
  countUnreadConversations,
  isPushConfigured,
  sendPushToUsers,
  type PushPayload,
} from './send'

/**
 * Push for an inbound WhatsApp message. Called by the webhook once the
 * message is stored and every automatic responder (Flows, the AI
 * auto-reply) has had its turn, so the notification can say what
 * actually happened:
 *
 *   bot_replied     — the customer wrote and something already answered
 *                     (a Flow, an automation, or the assistant). Pushed
 *                     *quietly*: it updates the app badge and shows a
 *                     silent, collapsible notification when the app is
 *                     closed, and is swallowed when the app is visible.
 *                     The team learns someone wrote without being
 *                     interrupted for a conversation the bot is holding.
 *   new_message     — nobody answered and the assistant isn't handling
 *                     this thread (not configured, human-assigned,
 *                     paused after a handoff, nothing textual to reply
 *                     to…). A normal notification: a human must reply.
 *   needs_attention — the assistant tried and stopped: it handed the
 *                     conversation over, hit its reply cap, was
 *                     rate-limited, or failed. The one the user asked
 *                     for explicitly — "exactly when a person has to
 *                     step in".
 *
 * Recipients: the assigned agent when there is one (the AI handoff may
 * have just assigned one — the row is re-read here, after the attempt),
 * otherwise every member of the account.
 */

export type InboundPushKind = 'bot_replied' | 'new_message' | 'needs_attention'

export interface InboundClassification {
  kind: InboundPushKind
  /** For needs_attention: which `Push.reason*` copy key explains it. */
  reasonKey?: 'reasonHandoff' | 'reasonCapReached' | 'reasonRateLimited' | 'reasonFailed'
}

export interface ClassifyInput {
  /** A Flow run consumed the message (flows win over the LLM). */
  flowConsumed: boolean
  /** The message was a button/list tap handled by an interactive menu. */
  interactiveReplyId: string | null
  /** The message carries text (or a voice-note transcript). */
  hasText: boolean
  /**
   * What the AI auto-reply dispatcher returned. `null` = the account
   * has no auto-reply configured; `undefined` = it wasn't invoked
   * (flow/interactive/no text — the flags above already say why).
   */
  aiAttempt: AutoReplyAttempt | null | undefined
}

export function classifyInbound(input: ClassifyInput): InboundClassification {
  if (input.flowConsumed || input.interactiveReplyId) return { kind: 'bot_replied' }
  if (!input.hasText) return { kind: 'new_message' }

  const attempt = input.aiAttempt
  if (!attempt) return { kind: 'new_message' }

  switch (attempt.outcome) {
    case 'replied':
      return { kind: 'bot_replied' }
    case 'handoff':
      return { kind: 'needs_attention', reasonKey: 'reasonHandoff' }
    case 'failed':
      return { kind: 'needs_attention', reasonKey: 'reasonFailed' }
    case 'skipped':
      switch (attempt.reason) {
        case 'automation_active':
          // A message-level automation owns auto-responses on this account.
          return { kind: 'bot_replied' }
        case 'cap_reached':
        case 'cap_race':
          return { kind: 'needs_attention', reasonKey: 'reasonCapReached' }
        case 'account_rate_limited':
          return { kind: 'needs_attention', reasonKey: 'reasonRateLimited' }
        default:
          // human_assigned, paused, no_context, conversation_missing, and
          // any reason added later: the bot stood aside on purpose, so a
          // human is expected to answer.
          return { kind: 'new_message' }
      }
    default:
      return { kind: 'new_message' }
  }
}

export interface NotifyInboundArgs {
  accountId: string
  conversationId: string
  contactId: string
  /** The customer's text (or transcript); empty for media-only. */
  previewText: string
  classification: InboundClassification
}

/**
 * Compose and send the push for one inbound message. Never throws.
 * Does nothing (and runs no queries) when VAPID keys aren't configured.
 */
export async function notifyInboundMessage(
  db: SupabaseClient,
  args: NotifyInboundArgs,
): Promise<void> {
  if (!isPushConfigured()) return
  try {
    const copy = await loadPushCopy()

    const [{ data: conversation }, { data: contact }] = await Promise.all([
      db
        .from('conversations')
        .select('assigned_agent_id, ai_handoff_summary')
        .eq('id', args.conversationId)
        .maybeSingle(),
      db
        .from('contacts')
        .select('name, phone, wa_username')
        .eq('id', args.contactId)
        .maybeSingle(),
    ])

    const conv = conversation as {
      assigned_agent_id: string | null
      ai_handoff_summary: string | null
    } | null
    const person = contact as {
      name: string | null
      phone: string | null
      wa_username: string | null
    } | null

    const userIds = conv?.assigned_agent_id
      ? [conv.assigned_agent_id]
      : await loadAccountMemberIds(db, args.accountId)
    if (userIds.length === 0) return

    const name = displayName(person, copy)
    const text = args.previewText.trim()
      ? preview(args.previewText)
      : (copy.mediaPreview ?? '')
    const badge = await countUnreadConversations(db, args.accountId)
    const url = `/inbox?c=${args.conversationId}`
    const tag = `conv-${args.conversationId}`

    let payload: PushPayload
    switch (args.classification.kind) {
      case 'bot_replied':
        payload = {
          type: 'bot_replied',
          title: fill(copy.botRepliedTitle ?? '{name}', { name }),
          body: text,
          url,
          tag,
          badge,
          quiet: true,
        }
        break
      case 'needs_attention': {
        const reasonKey = args.classification.reasonKey ?? 'reasonFailed'
        const reason = copy[reasonKey] ?? ''
        // The handoff summary is the assistant's own hand-over note —
        // the most useful line a human can get before opening the thread.
        const summary =
          reasonKey === 'reasonHandoff' && conv?.ai_handoff_summary
            ? ` ${preview(conv.ai_handoff_summary, 140)}`
            : ''
        payload = {
          type: 'needs_attention',
          title: fill(copy.needsAttentionTitle ?? '{name}', { name }),
          body: `${reason}${summary}`.trim() || text,
          url,
          tag,
          badge,
        }
        break
      }
      default:
        payload = {
          type: 'new_message',
          title: fill(copy.newMessageTitle ?? '{name}', { name }),
          body: text,
          url,
          tag,
          badge,
        }
    }

    await sendPushToUsers(db, { accountId: args.accountId, userIds, payload })
  } catch (err) {
    console.error('[push] inbound notification failed:', err)
  }
}

async function loadAccountMemberIds(db: SupabaseClient, accountId: string): Promise<string[]> {
  const { data, error } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
  if (error) {
    console.error('[push] member lookup failed:', error.message)
    return []
  }
  return ((data ?? []) as { user_id: string }[]).map((row) => row.user_id).filter(Boolean)
}

/**
 * Same preference order the inbox uses: a saved name, else the real
 * phone, else the WhatsApp @handle, else a "hidden number" label —
 * never the raw BSUID placeholder that `contacts.phone` holds for a
 * hidden-number customer.
 */
function displayName(
  contact: { name: string | null; phone: string | null; wa_username: string | null } | null,
  copy: Record<string, string>,
): string {
  if (contact?.name?.trim()) return contact.name.trim()
  if (contact?.phone && looksLikePhoneNumber(contact.phone)) return contact.phone
  if (contact?.wa_username) return `@${contact.wa_username}`
  return copy.hiddenNumber ?? 'WhatsApp'
}
