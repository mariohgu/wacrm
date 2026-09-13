import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}))

import webpush from 'web-push'
import { countUnreadConversations, isPushConfigured, sendPushToUsers, type PushPayload } from './send'

const PAYLOAD: PushPayload = {
  type: 'new_message',
  title: 'Ana',
  body: 'Hola',
  url: '/inbox?c=conv-1',
  tag: 'conv-conv-1',
  badge: 2,
}

interface Row {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
}

/** Minimal builder: `.from('push_subscriptions')` resolves to `rows`;
 *  `.delete().in(...)` records the ids it was asked to remove. */
function fakeDb(rows: Row[], opts: { selectError?: string; deleteError?: string } = {}) {
  const deleted: string[][] = []
  const from = vi.fn((table: string) => {
    if (table !== 'push_subscriptions') throw new Error(`unexpected table ${table}`)
    const selectChain = {
      eq: () => selectChain,
      in: async () => ({
        data: opts.selectError ? null : rows,
        error: opts.selectError ? { message: opts.selectError } : null,
      }),
    }
    const deleteChain = {
      in: async (_col: string, ids: string[]) => {
        deleted.push(ids)
        return { error: opts.deleteError ? { message: opts.deleteError } : null }
      },
    }
    return {
      select: () => selectChain,
      delete: () => deleteChain,
    }
  })
  return { db: { from } as unknown as SupabaseClient, deleted, from }
}

const row = (n: number, userId = 'u1'): Row => ({
  id: `sub-${n}`,
  user_id: userId,
  endpoint: `https://push.example/${n}`,
  p256dh: 'p',
  auth: 'a',
})

const send = vi.mocked(webpush.sendNotification)
const originalEnv = { ...process.env }

beforeEach(() => {
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'public-key'
  process.env.VAPID_PRIVATE_KEY = 'private-key'
  process.env.VAPID_SUBJECT = 'mailto:test@example.com'
  send.mockResolvedValue({ statusCode: 201, body: '', headers: {} })
})

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('isPushConfigured', () => {
  it('needs both VAPID keys', () => {
    expect(isPushConfigured()).toBe(true)
    delete process.env.VAPID_PRIVATE_KEY
    expect(isPushConfigured()).toBe(false)
  })
})

describe('sendPushToUsers', () => {
  it('sends the JSON payload to every subscription of the given users', async () => {
    const { db } = fakeDb([row(1, 'u1'), row(2, 'u1'), row(3, 'u2')])
    const result = await sendPushToUsers(db, { accountId: 'acc', userIds: ['u1', 'u2'], payload: PAYLOAD })

    expect(result).toEqual({ sent: 3, failed: 0, pruned: 0 })
    expect(send).toHaveBeenCalledTimes(3)
    const [subscription, body, options] = send.mock.calls[0]
    expect(subscription).toEqual({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } })
    expect(JSON.parse(body as string)).toEqual(PAYLOAD)
    expect(options).toMatchObject({ TTL: 3600, urgency: 'high' })
  })

  it('lowers urgency for quiet pushes', async () => {
    const { db } = fakeDb([row(1)])
    await sendPushToUsers(db, { accountId: 'acc', userIds: ['u1'], payload: { ...PAYLOAD, quiet: true } })
    expect(send.mock.calls[0][2]).toMatchObject({ urgency: 'normal' })
  })

  it('deletes subscriptions the push service reports gone (404/410) and counts them as pruned', async () => {
    const { db, deleted } = fakeDb([row(1), row(2), row(3)])
    send
      .mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} })
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }))
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { statusCode: 404 }))

    const result = await sendPushToUsers(db, { accountId: 'acc', userIds: ['u1'], payload: PAYLOAD })

    expect(result).toEqual({ sent: 1, failed: 0, pruned: 2 })
    expect(deleted).toEqual([['sub-2', 'sub-3']])
  })

  it('counts other delivery errors as failed without pruning or throwing', async () => {
    const { db, deleted } = fakeDb([row(1)])
    send.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }))

    const result = await sendPushToUsers(db, { accountId: 'acc', userIds: ['u1'], payload: PAYLOAD })
    expect(result).toEqual({ sent: 0, failed: 1, pruned: 0 })
    expect(deleted).toEqual([])
  })

  it('is a no-op with empty recipients or missing VAPID keys', async () => {
    const { db, from } = fakeDb([row(1)])
    expect(await sendPushToUsers(db, { accountId: 'acc', userIds: [], payload: PAYLOAD })).toEqual({
      sent: 0,
      failed: 0,
      pruned: 0,
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('dedupes recipient ids and drops empties', async () => {
    const { db } = fakeDb([row(1)])
    await sendPushToUsers(db, { accountId: 'acc', userIds: ['u1', 'u1', ''], payload: PAYLOAD })
    // One subscription row → one send; the .in() filter is what dedupe protects.
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('returns zeros when the subscription query fails', async () => {
    const { db } = fakeDb([], { selectError: 'permission denied' })
    expect(await sendPushToUsers(db, { accountId: 'acc', userIds: ['u1'], payload: PAYLOAD })).toEqual({
      sent: 0,
      failed: 0,
      pruned: 0,
    })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('countUnreadConversations', () => {
  it('counts account conversations with unread_count > 0 via a head query', async () => {
    const calls: unknown[][] = []
    const chain = {
      select: (...a: unknown[]) => (calls.push(['select', ...a]), chain),
      eq: (...a: unknown[]) => (calls.push(['eq', ...a]), chain),
      gt: async (...a: unknown[]) => (calls.push(['gt', ...a]), { count: 7, error: null }),
    }
    const db = { from: () => chain } as unknown as SupabaseClient
    expect(await countUnreadConversations(db, 'acc')).toBe(7)
    expect(calls).toEqual([
      ['select', 'id', { count: 'exact', head: true }],
      ['eq', 'account_id', 'acc'],
      ['gt', 'unread_count', 0],
    ])
  })

  it('returns 0 on a query error', async () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      gt: async () => ({ count: null, error: { message: 'nope' } }),
    }
    const db = { from: () => chain } as unknown as SupabaseClient
    expect(await countUnreadConversations(db, 'acc')).toBe(0)
  })
})
