import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext, buildCustomerContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().in().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('includes an audio message when it carries a transcript', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: 'transcribed voice note' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'transcribed voice note' }])
  })
})

/** Fake matching buildCustomerContext's two parallel queries: a
 *  contacts().select().eq().maybeSingle() lookup, and a messages()
 *  count query that resolves off the last chained .eq(). */
function fakeCustomerDb(opts: {
  contact: { name: string | null; phone: string | null } | null
  customerMessageCount: number
}): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'contacts') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: opts.contact, error: null }),
        }
        return chain
      }
      const chain = {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({ count: opts.customerMessageCount, error: null }),
      }
      return chain
    },
  } as unknown as SupabaseClient
}

describe('buildCustomerContext', () => {
  it('surfaces a real phone number and name as-is', async () => {
    const out = await buildCustomerContext(
      fakeCustomerDb({
        contact: { name: 'Thalía', phone: '+51912147223' },
        customerMessageCount: 1,
      }),
      'conv-1',
      'contact-1',
    )
    expect(out).toEqual({
      name: 'Thalía',
      phone: '+51912147223',
      isReturningCustomer: false,
    })
  })

  it('flags a returning customer when more than one customer message exists', async () => {
    const out = await buildCustomerContext(
      fakeCustomerDb({
        contact: { name: 'Thalía', phone: '+51912147223' },
        customerMessageCount: 4,
      }),
      'conv-1',
      'contact-1',
    )
    expect(out.isReturningCustomer).toBe(true)
  })

  it('never surfaces a WhatsApp-usernames BSUID placeholder as a phone number', async () => {
    const out = await buildCustomerContext(
      fakeCustomerDb({
        contact: { name: 'thali.vd_', phone: 'PE.1128521366369305' },
        customerMessageCount: 2,
      }),
      'conv-1',
      'contact-1',
    )
    expect(out.name).toBe('thali.vd_')
    expect(out.phone).toBeNull()
  })

  it('returns nulls when the contact row is missing', async () => {
    const out = await buildCustomerContext(
      fakeCustomerDb({ contact: null, customerMessageCount: 0 }),
      'conv-1',
      'contact-1',
    )
    expect(out).toEqual({ name: null, phone: null, isReturningCustomer: false })
  })
})
