import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AutoReplyAttempt } from '@/lib/ai/auto-reply'

vi.mock('./send', () => ({
  isPushConfigured: vi.fn(() => true),
  countUnreadConversations: vi.fn(async () => 4),
  sendPushToUsers: vi.fn(async () => ({ sent: 1, failed: 0, pruned: 0 })),
}))

vi.mock('./copy', async () => {
  const actual = await vi.importActual<typeof import('./copy')>('./copy')
  return {
    ...actual,
    loadPushCopy: vi.fn(async () => ({
      newMessageTitle: '{name}',
      botRepliedTitle: '{name} · assistant replied',
      needsAttentionTitle: '{name} needs a person',
      reasonHandoff: 'The assistant handed this conversation over.',
      reasonCapReached: 'The assistant reached its reply limit for this conversation.',
      reasonRateLimited: 'The assistant is rate-limited right now.',
      reasonFailed: 'The assistant could not reply.',
      hiddenNumber: 'Hidden number',
      mediaPreview: 'Sent an attachment',
    })),
  }
})

import { classifyInbound, notifyInboundMessage } from './inbound'
import { countUnreadConversations, isPushConfigured, sendPushToUsers } from './send'

const attempt = (
  outcome: AutoReplyAttempt['outcome'],
  reason: AutoReplyAttempt['reason'],
): AutoReplyAttempt => ({ outcome, reason, detail: null })

const base = { flowConsumed: false, interactiveReplyId: null, hasText: true }

describe('classifyInbound', () => {
  it.each<[string, Parameters<typeof classifyInbound>[0], ReturnType<typeof classifyInbound>]>([
    ['a Flow consumed the message', { ...base, flowConsumed: true, aiAttempt: undefined }, { kind: 'bot_replied' }],
    ['an interactive menu handled a tap', { ...base, interactiveReplyId: 'btn_1', aiAttempt: undefined }, { kind: 'bot_replied' }],
    ['media-only, nothing for the bot to read', { ...base, hasText: false, aiAttempt: undefined }, { kind: 'new_message' }],
    ['no auto-reply configured', { ...base, aiAttempt: null }, { kind: 'new_message' }],
    ['dispatcher not invoked (mocked away)', { ...base, aiAttempt: undefined }, { kind: 'new_message' }],
    ['the assistant replied', { ...base, aiAttempt: attempt('replied', 'sent') }, { kind: 'bot_replied' }],
    ['an automation owns auto-responses', { ...base, aiAttempt: attempt('skipped', 'automation_active') }, { kind: 'bot_replied' }],
    ['handoff', { ...base, aiAttempt: attempt('handoff', 'handoff') }, { kind: 'needs_attention', reasonKey: 'reasonHandoff' }],
    ['cap reached', { ...base, aiAttempt: attempt('skipped', 'cap_reached') }, { kind: 'needs_attention', reasonKey: 'reasonCapReached' }],
    ['cap race lost', { ...base, aiAttempt: attempt('skipped', 'cap_race') }, { kind: 'needs_attention', reasonKey: 'reasonCapReached' }],
    ['account rate-limited', { ...base, aiAttempt: attempt('skipped', 'account_rate_limited') }, { kind: 'needs_attention', reasonKey: 'reasonRateLimited' }],
    ['provider failure', { ...base, aiAttempt: attempt('failed', 'provider_error') }, { kind: 'needs_attention', reasonKey: 'reasonFailed' }],
    ['a human is assigned', { ...base, aiAttempt: attempt('skipped', 'human_assigned') }, { kind: 'new_message' }],
    ['paused after an earlier handoff', { ...base, aiAttempt: attempt('skipped', 'paused') }, { kind: 'new_message' }],
    ['nothing to reply to', { ...base, aiAttempt: attempt('skipped', 'no_context') }, { kind: 'new_message' }],
  ])('%s', (_label, input, expected) => {
    expect(classifyInbound(input)).toEqual(expected)
  })
})

// ---- notifyInboundMessage ----------------------------------------------

interface Rows {
  conversation: { assigned_agent_id: string | null; ai_handoff_summary: string | null } | null
  contact: { name: string | null; phone: string | null; wa_username: string | null } | null
  members: { user_id: string }[]
}

/** Just enough of the supabase query builder for the three reads the
 *  module makes. Each chain resolves to the table's preset rows. */
function fakeDb(rows: Rows): SupabaseClient {
  const from = (table: string) => {
    const single = table === 'conversations' ? rows.conversation : rows.contact
    const list = table === 'profiles' ? rows.members : []
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: single, error: null }),
      then: (resolve: (v: { data: unknown; error: null }) => void) =>
        resolve({ data: list, error: null }),
    }
    return chain
  }
  return { from } as unknown as SupabaseClient
}

const ARGS = {
  accountId: 'acc-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  previewText: 'Hola, ¿tienen turno para hoy a las 5?',
}

const lastPayload = () =>
  (vi.mocked(sendPushToUsers).mock.calls.at(-1)?.[1] ?? null) as
    | { accountId: string; userIds: string[]; payload: Record<string, unknown> }
    | null

beforeEach(() => {
  vi.mocked(isPushConfigured).mockReturnValue(true)
  vi.mocked(countUnreadConversations).mockResolvedValue(4)
})

describe('notifyInboundMessage', () => {
  it('does nothing — not even a query — when VAPID keys are not configured', async () => {
    vi.mocked(isPushConfigured).mockReturnValue(false)
    const from = vi.fn()
    await notifyInboundMessage({ from } as unknown as SupabaseClient, {
      ...ARGS,
      classification: { kind: 'new_message' },
    })
    expect(from).not.toHaveBeenCalled()
    expect(sendPushToUsers).not.toHaveBeenCalled()
  })

  it('pushes a normal "new message" to every member when nobody is assigned', async () => {
    const db = fakeDb({
      conversation: { assigned_agent_id: null, ai_handoff_summary: null },
      contact: { name: 'Ana Pérez', phone: '+51999888777', wa_username: null },
      members: [{ user_id: 'u1' }, { user_id: 'u2' }],
    })
    await notifyInboundMessage(db, { ...ARGS, classification: { kind: 'new_message' } })

    const call = lastPayload()!
    expect(call.accountId).toBe('acc-1')
    expect(call.userIds).toEqual(['u1', 'u2'])
    expect(call.payload).toMatchObject({
      type: 'new_message',
      title: 'Ana Pérez',
      body: ARGS.previewText,
      url: '/inbox?c=conv-1',
      tag: 'conv-conv-1',
      badge: 4,
    })
    expect(call.payload.quiet).toBeUndefined()
  })

  it('targets only the assigned agent, re-read after the AI ran', async () => {
    const db = fakeDb({
      conversation: { assigned_agent_id: 'agent-9', ai_handoff_summary: null },
      contact: { name: 'Ana', phone: null, wa_username: null },
      members: [{ user_id: 'u1' }, { user_id: 'u2' }],
    })
    await notifyInboundMessage(db, { ...ARGS, classification: { kind: 'new_message' } })
    expect(lastPayload()!.userIds).toEqual(['agent-9'])
  })

  it('marks a bot-handled message quiet but still carries the badge', async () => {
    const db = fakeDb({
      conversation: { assigned_agent_id: null, ai_handoff_summary: null },
      contact: { name: 'Ana', phone: null, wa_username: null },
      members: [{ user_id: 'u1' }],
    })
    await notifyInboundMessage(db, { ...ARGS, classification: { kind: 'bot_replied' } })
    expect(lastPayload()!.payload).toMatchObject({
      type: 'bot_replied',
      title: 'Ana · assistant replied',
      quiet: true,
      badge: 4,
    })
  })

  it('explains a handoff with the reason and the assistant\'s summary', async () => {
    const db = fakeDb({
      conversation: {
        assigned_agent_id: null,
        ai_handoff_summary: 'Customer wants to reschedule a colour appointment and is upset.',
      },
      contact: { name: 'Ana', phone: null, wa_username: null },
      members: [{ user_id: 'u1' }],
    })
    await notifyInboundMessage(db, {
      ...ARGS,
      classification: { kind: 'needs_attention', reasonKey: 'reasonHandoff' },
    })
    const payload = lastPayload()!.payload
    expect(payload.type).toBe('needs_attention')
    expect(payload.title).toBe('Ana needs a person')
    expect(payload.body).toBe(
      'The assistant handed this conversation over. Customer wants to reschedule a colour appointment and is upset.',
    )
    expect(payload.quiet).toBeUndefined()
  })

  it('never shows a BSUID placeholder as the name: prefers @username, then "Hidden number"', async () => {
    const rows: Rows = {
      conversation: { assigned_agent_id: null, ai_handoff_summary: null },
      contact: { name: null, phone: 'PE.1128521366369305', wa_username: 'thali.vd_' },
      members: [{ user_id: 'u1' }],
    }
    await notifyInboundMessage(fakeDb(rows), { ...ARGS, classification: { kind: 'new_message' } })
    expect(lastPayload()!.payload.title).toBe('@thali.vd_')

    rows.contact = { name: null, phone: 'PE.1128521366369305', wa_username: null }
    await notifyInboundMessage(fakeDb(rows), { ...ARGS, classification: { kind: 'new_message' } })
    expect(lastPayload()!.payload.title).toBe('Hidden number')
  })

  it('uses the attachment placeholder for a media-only message', async () => {
    const db = fakeDb({
      conversation: { assigned_agent_id: null, ai_handoff_summary: null },
      contact: { name: 'Ana', phone: null, wa_username: null },
      members: [{ user_id: 'u1' }],
    })
    await notifyInboundMessage(db, {
      ...ARGS,
      previewText: '   ',
      classification: { kind: 'new_message' },
    })
    expect(lastPayload()!.payload.body).toBe('Sent an attachment')
  })

  it('sends nothing when the account has no members to notify', async () => {
    vi.mocked(sendPushToUsers).mockClear()
    const db = fakeDb({
      conversation: { assigned_agent_id: null, ai_handoff_summary: null },
      contact: { name: 'Ana', phone: null, wa_username: null },
      members: [],
    })
    await notifyInboundMessage(db, { ...ARGS, classification: { kind: 'new_message' } })
    expect(sendPushToUsers).not.toHaveBeenCalled()
  })

  it('swallows unexpected errors — a push problem must not break the webhook', async () => {
    const db = {
      from: () => {
        throw new Error('db exploded')
      },
    } as unknown as SupabaseClient
    await expect(
      notifyInboundMessage(db, { ...ARGS, classification: { kind: 'new_message' } }),
    ).resolves.toBeUndefined()
  })
})
