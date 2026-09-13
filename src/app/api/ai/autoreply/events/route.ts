import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import type { AiReplyEventRow, AiReplyOutcome } from '@/lib/ai/reply-events'

// Bounded window/list so the tally is computed in-process over a small
// set. One row per inbound message on an account with auto-reply on, so
// a busy week is a few hundred rows.
const DEFAULT_WINDOW_DAYS = 7
const MAX_WINDOW_DAYS = 90
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const TALLY_ROWS = 2_000

type EventWithContact = AiReplyEventRow & {
  conversation: {
    id: string
    contact: { id: string; name: string | null; phone: string | null } | null
  } | null
}

/**
 * GET /api/ai/autoreply/events?days=7&limit=50  (admin+)
 *
 * Account-wide feed of auto-reply attempts (`ai_reply_events`) for
 * Agents → Usage: the most recent `limit` rows with the contact they
 * concern, plus a tally by outcome/reason over the whole window so an
 * admin can see at a glance "42 replied, 18 skipped: cap reached, 3
 * failed: provider error". Admin-gated to match the Usage tab it sits
 * in; the per-thread view (GET /api/ai/autoreply/[conversationId]) is
 * what every inbox role sees.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const url = new URL(request.url)
    const rawDays = Number(url.searchParams.get('days'))
    const days =
      Number.isFinite(rawDays) && rawDays >= 1
        ? Math.min(MAX_WINDOW_DAYS, Math.floor(rawDays))
        : DEFAULT_WINDOW_DAYS
    const rawLimit = Number(url.searchParams.get('limit'))
    const limit =
      Number.isFinite(rawLimit) && rawLimit >= 1
        ? Math.min(MAX_LIMIT, Math.floor(rawLimit))
        : DEFAULT_LIMIT

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const { data, error } = await supabase
      .from('ai_reply_events')
      .select(
        'id, conversation_id, message_id, outcome, reason, detail, created_at, conversation:conversations(id, contact:contacts(id, name, phone))',
      )
      .eq('account_id', accountId)
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(TALLY_ROWS + 1)

    if (error) {
      console.error('[ai/autoreply/events GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load auto-reply activity' },
        { status: 500 },
      )
    }

    const all = (data ?? []) as unknown as EventWithContact[]
    const truncated = all.length > TALLY_ROWS
    const rows = truncated ? all.slice(0, TALLY_ROWS) : all

    const tally = new Map<
      string,
      { outcome: AiReplyOutcome; reason: string; count: number }
    >()
    for (const r of rows) {
      const key = `${r.outcome}:${r.reason}`
      const t = tally.get(key) ?? { outcome: r.outcome, reason: r.reason, count: 0 }
      t.count += 1
      tally.set(key, t)
    }
    const byReason = [...tally.values()].sort((a, b) => b.count - a.count)

    return NextResponse.json({
      window_days: days,
      truncated,
      total: rows.length,
      by_reason: byReason,
      events: rows.slice(0, limit),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
