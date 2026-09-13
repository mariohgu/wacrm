import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import type { AiReplyEventRow } from '@/lib/ai/reply-events'

type Params = { params: Promise<{ conversationId: string }> }

/**
 * GET /api/ai/autoreply/[conversationId]  (viewer+)
 *
 * Per-thread auto-reply status for the inbox banner: how many replies
 * the bot has used against the account's per-conversation cap, and the
 * latest `ai_reply_events` row (what happened the last time a customer
 * message came in — replied / skipped / failed and why). This is what
 * turns "AI is replying automatically" into "AI hit its 3/3 limit" or
 * "last attempt failed: OpenRouter 402".
 *
 * Reads go through the RLS-scoped SSR client (`ai_reply_events` and
 * `ai_configs` are both member-readable), so a conversation outside the
 * caller's account is a 404.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { conversationId } = await params

    const [convRes, configRes, eventRes] = await Promise.all([
      supabase
        .from('conversations')
        .select('id, ai_reply_count, ai_autoreply_disabled')
        .eq('id', conversationId)
        .eq('account_id', accountId)
        .maybeSingle(),
      supabase
        .from('ai_configs')
        .select('auto_reply_max_per_conversation')
        .eq('account_id', accountId)
        .maybeSingle(),
      supabase
        .from('ai_reply_events')
        .select('id, conversation_id, message_id, outcome, reason, detail, created_at')
        .eq('account_id', accountId)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    if (convRes.error) {
      console.error('[ai/autoreply GET] conversation lookup error:', convRes.error)
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 },
      )
    }
    if (!convRes.data) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    if (eventRes.error) {
      // Most likely migration 040 not applied yet — degrade to "no
      // events" rather than breaking the banner, but say so in the log.
      console.error('[ai/autoreply GET] events lookup error:', eventRes.error)
    }

    const replyCount = convRes.data.ai_reply_count ?? 0
    const maxReplies = configRes.data?.auto_reply_max_per_conversation ?? null

    return NextResponse.json({
      reply_count: replyCount,
      max_replies: maxReplies,
      cap_reached: maxReplies !== null && replyCount >= maxReplies,
      last_event: (eventRes.data as AiReplyEventRow | null) ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/autoreply/[conversationId]  (agent+)
 *
 * Toggle the AI auto-reply bot for one conversation from the inbox — the
 * "Take over" / "Resume AI" banner.
 *
 * Body: { paused: boolean, assign_to_me?: boolean }
 *   - paused: true  → pause the bot here (a human is taking over). When
 *                     `assign_to_me` is set, also assign the thread to the
 *                     caller (the usual "Take over" flow). Assignment
 *                     fires the `on_conversation_assigned` trigger.
 *   - paused: false → hand the thread back to the bot: clear the pause,
 *                     reset the per-conversation reply count so it gets
 *                     fresh slots, and clear the handoff note. If the
 *                     caller currently owns the thread, unassign it too so
 *                     the bot isn't blocked by the "human owns this" gate.
 *
 * Writes go through the RLS-scoped SSR client, so a conversation outside
 * the caller's account simply isn't found (404).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    // Reuse the send bucket: this is a cheap per-user inbox action and
    // toggling it in a tight loop has no legitimate use.
    const limit = checkRateLimit(`ai-takeover:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { conversationId } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body.paused !== 'boolean') {
      return NextResponse.json(
        { error: 'paused (boolean) is required' },
        { status: 400 },
      )
    }
    const paused = body.paused as boolean
    const assignToMe = body.assign_to_me === true

    // Confirm the conversation is in the caller's account before writing.
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/autoreply] conversation lookup error:', convErr)
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 },
      )
    }
    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const update: Record<string, unknown> = { ai_autoreply_disabled: paused }

    if (paused) {
      if (assignToMe) update.assigned_agent_id = userId
    } else {
      // Resuming hands the thread *back to the bot*. Clear the pause and
      // the handoff note, and — crucially — release ANY assignment, not
      // just the caller's own: the auto-reply eligibility gate stands
      // down whenever a human is assigned, so leaving a stale assignee
      // (e.g. the agent a prior handoff routed to) would silently keep
      // the bot muted and make "Resume AI" a no-op. This is the explicit
      // choice to let the bot own the thread again.
      update.assigned_agent_id = null
      // Give the bot a fresh reply budget on this thread. This is a
      // deliberate, manual, rate-limited action (not automatable), so it
      // can't be used to bypass the per-conversation cap at scale — it's
      // a human choosing to re-engage the assistant.
      update.ai_reply_count = 0
      update.ai_handoff_summary = null
    }

    const { error: upErr } = await supabase
      .from('conversations')
      .update(update)
      .eq('id', conversationId)
      .eq('account_id', accountId)
    if (upErr) {
      console.error('[ai/autoreply] update error:', upErr)
      return NextResponse.json(
        { error: 'Failed to update conversation' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, paused })
  } catch (err) {
    return toErrorResponse(err)
  }
}
