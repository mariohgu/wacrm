import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// AI auto-reply attempt log (`ai_reply_events`, migration 040).
//
// `dispatchInboundToAiReply` has a dozen exit paths and, before this
// existed, every one of them was a silent `return`: the inbox banner
// kept saying "AI is replying automatically" while the bot had actually
// hit its per-conversation cap, been rate-limited, or crashed on the
// provider call. One row per attempt here is what lets the inbox (and
// Agents → Usage) answer "why didn't the assistant reply?".
// ============================================================

export type AiReplyOutcome = 'replied' | 'handoff' | 'skipped' | 'failed'

/**
 * Machine-readable reason per outcome. Kept as a closed union in code
 * (so the UI can translate every one) but stored as free text in the DB
 * (so adding a code never needs a migration).
 *
 *   replied  → 'sent'
 *   handoff  → 'handoff'
 *   skipped  → a deliberate stand-down (nothing is wrong)
 *   failed   → something broke; `detail` carries the message
 */
export type AiReplyReason =
  | 'sent'
  | 'handoff'
  // skipped
  | 'automation_active'
  | 'conversation_missing'
  | 'human_assigned'
  | 'paused'
  | 'cap_reached'
  | 'no_context'
  | 'account_rate_limited'
  | 'cap_race'
  // failed
  | 'config_error'
  | 'provider_error'
  | 'claim_error'
  | 'send_error'
  | 'unknown_error'

export const AI_REPLY_REASONS: readonly AiReplyReason[] = [
  'sent',
  'handoff',
  'automation_active',
  'conversation_missing',
  'human_assigned',
  'paused',
  'cap_reached',
  'no_context',
  'account_rate_limited',
  'cap_race',
  'config_error',
  'provider_error',
  'claim_error',
  'send_error',
  'unknown_error',
]

export function isAiReplyReason(v: unknown): v is AiReplyReason {
  return (
    typeof v === 'string' && (AI_REPLY_REASONS as readonly string[]).includes(v)
  )
}

export interface AiReplyEventInput {
  accountId: string
  conversationId: string | null
  /** The inbound `messages.id` that triggered the attempt, when known. */
  messageId: string | null
  outcome: AiReplyOutcome
  reason: AiReplyReason
  /** Failure detail (provider message, etc.). Truncated on write. */
  detail?: string | null
}

/** Row shape as read back by the API routes / UI. */
export interface AiReplyEventRow {
  id: string
  conversation_id: string | null
  message_id: string | null
  outcome: AiReplyOutcome
  reason: string
  detail: string | null
  created_at: string
}

const MAX_DETAIL_CHARS = 500

/** Trim an error to a storable, key-free one-liner. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    const prefix = typeof code === 'string' && code ? `${code}: ` : ''
    return `${prefix}${err.message}`
  }
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Best-effort append to `ai_reply_events`. NEVER throws — this runs on
 * the webhook's inbound path, and an audit-log failure must not affect
 * (or be mistaken for) the reply itself. Any DB error is logged and
 * swallowed. Pass the service-role admin client: there is no
 * `authenticated` INSERT policy on the table.
 */
export async function logAiReplyEvent(
  db: SupabaseClient,
  input: AiReplyEventInput,
): Promise<void> {
  try {
    const detail =
      input.detail && input.detail.length > MAX_DETAIL_CHARS
        ? `${input.detail.slice(0, MAX_DETAIL_CHARS - 1)}…`
        : (input.detail ?? null)
    const { error } = await db.from('ai_reply_events').insert({
      account_id: input.accountId,
      conversation_id: input.conversationId,
      message_id: input.messageId,
      outcome: input.outcome,
      reason: input.reason,
      detail,
    })
    if (error) {
      console.error('[ai reply-events] insert failed:', error)
    }
  } catch (err) {
    console.error('[ai reply-events] insert threw:', err)
  }
}
