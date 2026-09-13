import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describeError, logAiReplyEvent } from './reply-events'
import { AiError } from './types'

function fakeDb(insertResult: { error: unknown } = { error: null }) {
  const insert = vi.fn().mockResolvedValue(insertResult)
  const db = { from: vi.fn(() => ({ insert })) }
  return { db: db as unknown as SupabaseClient, insert, from: db.from }
}

describe('logAiReplyEvent', () => {
  it('inserts a row with the outcome, reason and detail', async () => {
    const { db, insert, from } = fakeDb()
    await logAiReplyEvent(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      outcome: 'failed',
      reason: 'provider_error',
      detail: 'rate_limited: OpenRouter rate limit reached',
    })
    expect(from).toHaveBeenCalledWith('ai_reply_events')
    expect(insert).toHaveBeenCalledWith({
      account_id: 'acct-1',
      conversation_id: 'conv-1',
      message_id: 'msg-1',
      outcome: 'failed',
      reason: 'provider_error',
      detail: 'rate_limited: OpenRouter rate limit reached',
    })
  })

  it('stores null detail when none is given', async () => {
    const { db, insert } = fakeDb()
    await logAiReplyEvent(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      messageId: null,
      outcome: 'skipped',
      reason: 'cap_reached',
    })
    expect(insert.mock.calls[0][0]).toMatchObject({
      detail: null,
      message_id: null,
    })
  })

  it('truncates an oversized detail', async () => {
    const { db, insert } = fakeDb()
    await logAiReplyEvent(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      messageId: null,
      outcome: 'failed',
      reason: 'unknown_error',
      detail: 'x'.repeat(2000),
    })
    const detail = insert.mock.calls[0][0].detail as string
    expect(detail.length).toBe(500)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('never throws when the insert errors or rejects', async () => {
    const { db } = fakeDb({ error: { message: 'boom' } })
    await expect(
      logAiReplyEvent(db, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        messageId: null,
        outcome: 'replied',
        reason: 'sent',
      }),
    ).resolves.toBeUndefined()

    const throwing = {
      from: () => ({ insert: () => Promise.reject(new Error('down')) }),
    } as unknown as SupabaseClient
    await expect(
      logAiReplyEvent(throwing, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        messageId: null,
        outcome: 'replied',
        reason: 'sent',
      }),
    ).resolves.toBeUndefined()
  })
})

describe('describeError', () => {
  it('prefixes an AiError with its code', () => {
    const err = new AiError('OpenRouter rate limit reached', {
      code: 'rate_limited',
    })
    expect(describeError(err)).toBe(
      'rate_limited: OpenRouter rate limit reached',
    )
  })

  it('uses the plain message for a generic Error', () => {
    expect(describeError(new Error('contact not found'))).toBe(
      'contact not found',
    )
  })

  it('stringifies non-Error values', () => {
    expect(describeError('oops')).toBe('oops')
    expect(describeError({ message: 'x' })).toBe('{"message":"x"}')
  })
})
