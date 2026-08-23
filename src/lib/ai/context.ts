import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'
import { looksLikePhoneNumber } from '@/lib/whatsapp/phone-utils'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Audio messages are included when
 * they carry a transcript (`content_text` — see the webhook's audio
 * case and `transcription.ts`); other media, templates, and interactive
 * replies are excluded — they carry no text to model. An audio row
 * with no transcript (transcription not configured, or it failed) is
 * dropped by the empty-content_text filter below, same as any other
 * row with nothing to say.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'audio'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text!.trim(),
    }))
}

export interface CustomerContext {
  name: string | null
  /**
   * Only ever a real phone number. A WhatsApp-usernames customer whose
   * number is hidden has a BSUID routing token parked in `contacts.phone`
   * instead (see CLAUDE.md's "WhatsApp contact identity" section) — that
   * token is never surfaced here, since handing it to the model as "the
   * customer's phone number" would be actively wrong.
   */
  phone: string | null
  /** True when the customer has written in this thread before — this
   *  CRM reuses/reopens one conversation per contact rather than
   *  starting a fresh thread each session, so "more than one customer
   *  message in this conversation" is the same signal the webhook uses
   *  for the `first_inbound_message` automation trigger. */
  isReturningCustomer: boolean
}

/**
 * Look up what the CRM already knows about this contact, so the system
 * prompt can tell the model not to ask for a name/number it already has
 * on file. Best-effort by design (mirrors buildConversationContext's
 * lookup pattern) — a lookup failure just means the model asks the
 * customer directly, same as before this existed.
 */
export async function buildCustomerContext(
  db: SupabaseClient,
  conversationId: string,
  contactId: string,
): Promise<CustomerContext> {
  const [{ data: contact }, { count }] = await Promise.all([
    db.from('contacts').select('name, phone').eq('id', contactId).maybeSingle(),
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer'),
  ])

  const phone = contact?.phone
  return {
    name: contact?.name?.trim() || null,
    phone: phone && looksLikePhoneNumber(phone) ? phone : null,
    isReturningCustomer: (count ?? 0) > 1,
  }
}
