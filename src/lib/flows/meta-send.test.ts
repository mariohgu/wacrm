import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { engineSendText } from './meta-send'

const sendTextMessage = vi.fn(async () => ({ messageId: 'wamid.text' }))

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: (...args: unknown[]) =>
    (sendTextMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendMediaMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
}))

let currentDb: SupabaseClient | null = null
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => currentDb,
}))

interface FakeContact {
  id: string
  phone: string | null
  wa_user_id?: string | null
}

interface CapturedWrites {
  contactUpdate?: Record<string, unknown>
}

function fakeDb(contact: FakeContact | null, captured: CapturedWrites): SupabaseClient {
  const config = { id: 'cfg-1', phone_number_id: 'pn-1', access_token: 'token' }
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (table === 'contacts') return { data: contact, error: null }
          return { data: null, error: null }
        },
        single: async () => {
          if (table === 'whatsapp_config') return { data: config, error: null }
          return { data: null, error: null }
        },
        insert: () => ({ error: null }),
        update: (row: Record<string, unknown>) => {
          if (table === 'contacts') captured.contactUpdate = row
          return builder
        },
      }
      return builder
    },
  } as unknown as SupabaseClient
}

const BASE_ARGS = {
  accountId: 'acct-1',
  userId: 'u-1',
  conversationId: 'cv-1',
  text: 'hola',
}

describe('engineSendText', () => {
  it('sends via `to` and keeps phone-variant retry behavior for a real phone', async () => {
    sendTextMessage.mockClear()
    const captured: CapturedWrites = {}
    currentDb = fakeDb({ id: 'ct-1', phone: '+15551234567' }, captured)

    const result = await engineSendText({ ...BASE_ARGS, contactId: 'ct-1' })

    expect(result.whatsapp_message_id).toBe('wamid.text')
    expect(
      (sendTextMessage.mock.calls[0] as unknown as [{ recipientTarget: unknown }])[0]
        .recipientTarget
    ).toEqual({ type: 'phone', value: '15551234567' })
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
  })

  it('sends via `recipient` (wa_user_id) once, no retry loop, for a BSUID contact', async () => {
    sendTextMessage.mockClear()
    const captured: CapturedWrites = {}
    currentDb = fakeDb(
      { id: 'ct-2', phone: 'PE.1128521366369305', wa_user_id: 'PE.1128521366369305' },
      captured
    )

    const result = await engineSendText({ ...BASE_ARGS, contactId: 'ct-2' })

    expect(result.whatsapp_message_id).toBe('wamid.text')
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
    expect(
      (sendTextMessage.mock.calls[0] as unknown as [{ recipientTarget: unknown }])[0]
        .recipientTarget
    ).toEqual({ type: 'user_id', value: 'PE.1128521366369305' })
    // Nothing to auto-correct on a BSUID send.
    expect(captured.contactUpdate).toBeUndefined()
  })

  it('throws before calling Meta when phone is a BSUID placeholder with no wa_user_id', async () => {
    sendTextMessage.mockClear()
    const captured: CapturedWrites = {}
    currentDb = fakeDb({ id: 'ct-3', phone: 'PE.1128521366369305' }, captured)

    await expect(
      engineSendText({ ...BASE_ARGS, contactId: 'ct-3' })
    ).rejects.toThrow(/contact phone invalid/)
    expect(sendTextMessage).not.toHaveBeenCalled()
  })
})
