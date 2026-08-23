import { describe, it, expect, vi, beforeEach } from 'vitest'

// Shared, hoisted state the module mocks close over. Reset per test.
const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  state: {
    // Result the message upsert's .select() resolves to. A genuine insert
    // returns the row; a replayed delivery conflicts and returns [].
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    priorCustomerMsgCount: 0,
    /** Row `lookupInternalIdByMetaId` resolves for a `context.id`. */
    replyContextParent: null as { id: string } | null,
    conversation: { id: 'conv-1', unread_count: 0, account_id: 'acc-1' },
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    afterCallbacks: [] as (() => Promise<void> | void)[],
    automationStarted: 0,
    automationCompleted: 0,
    /** whatsapp_config.mirror_inbound_media for the matched row (#466). */
    mirrorInboundMedia: true as boolean | undefined,
    /** Objects the inbound-media mirror pushed into chat-media. */
    storageUploads: [] as {
      bucket: string
      path: string
      options: { contentType?: string }
    }[],
    /** Error the next storage upload resolves with, if any. */
    storageUploadError: null as { message: string } | null,
    /** In-memory `contacts` table, used by findOrCreateContact's
     *  username-first and BSUID fallback-id paths (bypassing the mocked
     *  `findExistingContact`, which only covers the plain-phone lookup).
     *  Persists across runWebhook() calls within one test so a second
     *  message can prove it reused the row. */
    contactsTable: [] as {
      id: string
      phone: string
      name: string
      wa_username: string | null
      wa_user_id: string | null
    }[],
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'whatsapp_config':
          return {
            select: () => ({
              eq: () =>
                Promise.resolve({
                  data: [
                    {
                      account_id: 'acc-1',
                      user_id: 'user-1',
                      access_token: 'enc',
                      mirror_inbound_media: h.state.mirrorInboundMedia,
                    },
                  ],
                  error: null,
                }),
            }),
          }
        case 'conversations':
          // findOrCreateConversation: select().eq().eq().order().limit()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [h.state.conversation],
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
          }
        case 'broadcast_recipients':
          // flagBroadcastReplyIfAny: select().eq().eq().in().order().limit()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => ({
                    order: () => ({
                      limit: () =>
                        Promise.resolve({ data: [], error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }
        case 'messages':
          return {
            // Two different chains land here, told apart by the count
            // option: the prior-message count (head request) and the
            // reply-context parent lookup.
            select: (_columns: string, options?: { head?: boolean }) =>
              options?.head
                ? // priorCustomerMsgCount: select('id',{count,head}).eq().eq()
                  {
                    eq: () => ({
                      eq: () =>
                        Promise.resolve({
                          count: h.state.priorCustomerMsgCount,
                          error: null,
                        }),
                    }),
                  }
                : // lookupInternalIdByMetaId: select('id').eq().eq().maybeSingle()
                  {
                    eq: () => ({
                      eq: () => ({
                        maybeSingle: () =>
                          Promise.resolve({
                            data: h.state.replyContextParent,
                            error: null,
                          }),
                      }),
                    }),
                  },
            // Idempotent insert: upsert(...).select('id')
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.upsertCalls.push({ row, options })
              return {
                select: () =>
                  Promise.resolve({
                    data: h.state.messageUpsertResult,
                    error: null,
                  }),
              }
            },
          }
        case 'contacts': {
          // Reached by findOrCreateContact's username-first lookup and
          // its BSUID fallback-id branch (usingFallbackId) — the
          // ordinary phone path goes through the mocked
          // findExistingContact below instead. A small in-memory table
          // with a generic `.eq().eq()...maybeSingle()` chain so both
          // `(account_id, wa_username_normalized)` and
          // `(account_id, phone)` lookups work through the same mock.
          const where: Record<string, string> = {}
          const chain = {
            eq: (col: string, val: string) => {
              where[col] = val
              return chain
            },
            maybeSingle: () => {
              const row = h.state.contactsTable.find((c) => {
                if (
                  where.wa_username_normalized !== undefined &&
                  (c.wa_username ?? '').toLowerCase() !== where.wa_username_normalized
                ) {
                  return false
                }
                if (where.phone !== undefined && c.phone !== where.phone) return false
                return true
              })
              return Promise.resolve({ data: row ?? null, error: null })
            },
          }
          return {
            select: () => chain,
            insert: (row: Record<string, unknown>) => ({
              select: () => ({
                single: () => {
                  const newRow = {
                    id: `contact-fallback-${h.state.contactsTable.length + 1}`,
                    phone: row.phone as string,
                    name: row.name as string,
                    wa_username: (row.wa_username as string | null) ?? null,
                    wa_user_id: (row.wa_user_id as string | null) ?? null,
                  }
                  h.state.contactsTable.push(newRow)
                  return Promise.resolve({ data: newRow, error: null })
                },
              }),
            }),
            update: (patch: Record<string, unknown>) => ({
              eq: (_col: string, id: string) => {
                const row = h.state.contactsTable.find((c) => c.id === id)
                if (row) Object.assign(row, patch)
                return Promise.resolve({ error: null })
              },
            }),
          }
        }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: null, error: null })
    },
    // Service-role Storage, used by the inbound-media mirror (#466).
    storage: {
      from(bucket: string) {
        return {
          upload: (
            path: string,
            _body: unknown,
            options: { contentType?: string },
          ) => {
            h.state.storageUploads.push({ bucket, path, options })
            return Promise.resolve({ error: h.state.storageUploadError })
          },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
          }),
        }
      },
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })),
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}))
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: () => false,
  handleTemplateWebhookChange: vi.fn(),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))

import { POST } from './route'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

const mockGetMediaUrl = vi.mocked(getMediaUrl)
const mockDownloadMedia = vi.mocked(downloadMedia)

const TEXT_MESSAGE = {
  id: 'wamid.TEST1',
  from: '15551230000',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hello' },
}

const DEFAULT_CONTACTS = [{ wa_id: '15551230000', profile: { name: 'Ada' } }]

function inboundRequest(
  message: Record<string, unknown> = TEXT_MESSAGE,
  contacts: Record<string, unknown>[] = DEFAULT_CONTACTS,
) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              contacts,
              messages: [message],
            },
          },
        ],
      },
    ],
  }
  return {
    text: async () => JSON.stringify(body),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request
}

async function runWebhook(
  message?: Record<string, unknown>,
  contacts?: Record<string, unknown>[],
) {
  const res = await POST(inboundRequest(message, contacts))
  // Drain the after() callback exactly as the runtime would.
  for (const cb of h.state.afterCallbacks) await cb()
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.messageUpsertResult = [{ id: 'msg-1' }]
  h.state.priorCustomerMsgCount = 0
  h.state.replyContextParent = null
  h.state.conversation = { id: 'conv-1', unread_count: 0, account_id: 'acc-1' }
  h.state.upsertCalls = []
  h.state.rpcCalls = []
  h.state.afterCallbacks = []
  h.state.automationStarted = 0
  h.state.automationCompleted = 0
  h.state.mirrorInboundMedia = true
  h.state.storageUploads = []
  h.state.storageUploadError = null
  h.state.contactsTable = []
  mockGetMediaUrl.mockResolvedValue({
    url: 'https://lookaside.fbsbx.com/whatsapp/abc',
    mimeType: 'image/jpeg',
    fileSize: 2048,
  })
  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.alloc(2048),
    contentType: 'image/jpeg',
  })
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  h.runAutomationsForTrigger.mockImplementation(() => {
    h.state.automationStarted++
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        h.state.automationCompleted++
        resolve()
      }, 0)
    })
  })
})

describe('inbound webhook: idempotent insert (#367)', () => {
  it('a genuine first delivery persists once and fans out downstream', async () => {
    await runWebhook()

    // Inserted via upsert with the (conversation_id, message_id) conflict
    // target — not a bare insert.
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].options).toMatchObject({
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    })
    // Downstream side effects ran exactly once.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it('a replayed delivery is a no-op: no unread bump, no fan-out', async () => {
    // Upsert hits the unique index and returns no row.
    h.state.messageUpsertResult = []

    await runWebhook()

    expect(h.state.upsertCalls).toHaveLength(1)
    // None of the downstream side effects fire on a replay.
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })
})

describe('inbound webhook: atomic unread bump (#369)', () => {
  it('increments unread through the DB-side RPC, not a read-modify-write', async () => {
    await runWebhook()

    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.state.rpcCalls[0]).toMatchObject({
      name: 'bump_conversation_on_inbound',
      args: { p_conversation_id: 'conv-1' },
    })
  })
})

describe('inbound webhook: template quick-reply buttons (#478)', () => {
  // A customer tapping a QUICK_REPLY button on a broadcast template.
  // `context.id` points at the template message we sent — which the
  // broadcast path never wrote to `messages`, so the parent lookup
  // legitimately misses and the reply is stored unquoted.
  const templateButtonTap = {
    id: 'wamid.BTN1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'button',
    button: { text: 'Yes, interested', payload: 'YES_INTERESTED' },
    context: { id: 'wamid.BROADCAST1' },
  }

  it('stores the tap as an interactive reply, not an unsupported message', async () => {
    await runWebhook(templateButtonTap)

    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Yes, interested',
      interactive_reply_id: 'YES_INTERESTED',
      reply_to_message_id: null,
    })
  })

  it('routes the tap to flows and fires the interactive_reply trigger', async () => {
    await runWebhook(templateButtonTap)

    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          kind: 'interactive_reply',
          reply_id: 'YES_INTERESTED',
          reply_title: 'Yes, interested',
          meta_message_id: 'wamid.BTN1',
        },
      }),
    )
    const triggers = h.runAutomationsForTrigger.mock.calls.map(
      (call) => (call[0] as { triggerType: string }).triggerType,
    )
    expect(triggers).toContain('interactive_reply')
    // The AI auto-reply must stay out of it — a button tap is not a
    // free-text question.
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('falls back to the label when the template button carries no payload', async () => {
    await runWebhook({
      ...templateButtonTap,
      button: { text: 'Track my order' },
    })

    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Track my order',
      interactive_reply_id: 'Track my order',
    })
  })
})

describe('inbound webhook: inbound media is mirrored (#466)', () => {
  const IMAGE_MESSAGE = {
    id: 'wamid.IMG1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'image',
    image: { id: '1234567890123456', mime_type: 'image/jpeg', caption: 'hi' },
  }

  it('stores a durable bucket URL instead of the expiring proxy path', async () => {
    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
    expect(h.state.storageUploads[0].bucket).toBe('chat-media')
    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
    )
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url:
        'https://cdn.test/chat-media/account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
      // Meta's MIME type used to be discarded outright (`void mediaType`).
      media_type: 'image/jpeg',
    })
  })

  it('falls back to the proxy URL when the upload is refused', async () => {
    h.state.storageUploadError = { message: 'mime type not supported' }

    await runWebhook(IMAGE_MESSAGE)

    // The message still lands, and it still lands with a usable URL —
    // the mirror failing must never cost us the message.
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      media_type: 'image/jpeg',
    })
  })

  it('falls back to the proxy URL when the download from Meta throws', async () => {
    mockDownloadMedia.mockRejectedValueOnce(new Error('Media download failed: 404'))

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
    })
  })

  it('skips media larger than the bucket accepts, without downloading it', async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/big',
      mimeType: 'application/pdf',
      fileSize: 40 * 1024 * 1024,
    })

    await runWebhook({
      id: 'wamid.DOC1',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '999',
        mime_type: 'application/pdf',
        filename: 'huge.pdf',
      },
    })

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/999',
      media_type: 'application/pdf',
    })
  })

  it("names the object after a document's own filename", async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/doc',
      mimeType: 'application/pdf',
      fileSize: 4096,
    })
    mockDownloadMedia.mockResolvedValue({
      buffer: Buffer.alloc(4096),
      contentType: 'application/pdf',
    })

    await runWebhook({
      id: 'wamid.DOC2',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '1234567890123456',
        mime_type: 'application/pdf',
        filename: 'invoice.pdf',
        caption: 'have a look',
      },
    })

    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-invoice.pdf',
    )
  })

  it('does not mirror when the account has opted out', async () => {
    h.state.mirrorInboundMedia = false

    await runWebhook(IMAGE_MESSAGE)

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      // Still recorded — the MIME type costs nothing and makes the
      // download name right even for proxied media.
      media_type: 'image/jpeg',
    })
  })

  it('mirrors when the column is absent, e.g. a row read before migration 039', async () => {
    h.state.mirrorInboundMedia = undefined

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
  })

  it('leaves text messages alone', async () => {
    await runWebhook()

    expect(mockGetMediaUrl).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({ media_type: null })
  })
})

describe('inbound webhook: WhatsApp usernames (BSUID) fallback identity', () => {
  // Meta's "WhatsApp usernames" rollout: a hidden-number customer's
  // inbound message OMITS `from` entirely (not present-but-garbled) —
  // confirmed against a real payload from an affected account. The
  // identifier instead lives in `from_user_id` (mirrored on the contact
  // as `user_id`), format "CC.digits" (e.g. "PE.1128521366369305").
  // normalizePhone(undefined) would reduce that to '', so
  // findOrCreateContact must fall back to an exact match on the raw id
  // instead of creating a new contact on every message.
  const BSUID_MESSAGE = {
    id: 'wamid.BSUID1',
    // No `from` key — real payloads omit it for a hidden-number sender.
    from_user_id: 'PE.1128521366369305',
    timestamp: '1700000000',
    type: 'text',
    text: { body: 'hello from a hidden number' },
  }
  const BSUID_CONTACTS = [
    {
      // A real decorative-Unicode display name, as seen in production —
      // `username` should be preferred over this for the stored name.
      profile: { name: '𐹚𝓕𝓉𝒂𝓍𝒊𝒂꒱', username: 'thali.vd_' },
      user_id: 'PE.1128521366369305',
    },
  ]

  it('creates exactly one contact, keyed on the raw sender id', async () => {
    await runWebhook(BSUID_MESSAGE, BSUID_CONTACTS)

    expect(h.state.contactsTable).toHaveLength(1)
    expect(h.state.contactsTable[0].phone).toBe('PE.1128521366369305')
  })

  it('reuses the same contact for a second message from the same non-phone id', async () => {
    await runWebhook({ ...BSUID_MESSAGE, id: 'wamid.BSUID1' }, BSUID_CONTACTS)
    await runWebhook({ ...BSUID_MESSAGE, id: 'wamid.BSUID2' }, BSUID_CONTACTS)

    // The old behavior created a brand-new contact per message here —
    // this is the regression the fallback-id lookup guards against.
    expect(h.state.contactsTable).toHaveLength(1)
  })

  it('prefers profile.username over the decorative profile.name for the stored contact name', async () => {
    await runWebhook(BSUID_MESSAGE, BSUID_CONTACTS)

    expect(h.state.contactsTable[0].name).toBe('thali.vd_')
  })
})

describe('inbound webhook: username-based identity (survives a rotated BSUID token)', () => {
  // The bug report this guards against: a customer messaged once, staff
  // saved their real phone number, and the customer's NEXT hidden-
  // number message still spawned a second contact — because the prior
  // fix deduped purely on the BSUID token, which is a routing
  // credential that can rotate, not a stable identity. `wa_username` is
  // the durable signal instead.
  it('resolves to the same contact when the same username reappears under a different token', async () => {
    await runWebhook(
      {
        id: 'wamid.ROT1',
        from_user_id: 'PE.TOKEN_OLD',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'hi' },
      },
      [{ profile: { name: 'Thali', username: 'thali.vd_' }, user_id: 'PE.TOKEN_OLD' }],
    )
    await runWebhook(
      {
        id: 'wamid.ROT2',
        from_user_id: 'PE.TOKEN_NEW',
        timestamp: '1700000001',
        type: 'text',
        text: { body: 'hi again' },
      },
      [{ profile: { name: 'Thali', username: 'thali.vd_' }, user_id: 'PE.TOKEN_NEW' }],
    )

    expect(h.state.contactsTable).toHaveLength(1)
    // The routing token was refreshed to the latest one seen.
    expect(h.state.contactsTable[0].wa_user_id).toBe('PE.TOKEN_NEW')
  })

  it('matches a hidden-number message to a contact staff already linked by username', async () => {
    // Simulates staff typing "thali.vd_" into the WhatsApp-username
    // field on a contact that already has the customer's real phone.
    h.state.contactsTable.push({
      id: 'contact-linked',
      phone: '+51912147223',
      name: 'Thali Vasquez',
      wa_username: 'thali.vd_',
      wa_user_id: null,
    })

    await runWebhook(
      {
        id: 'wamid.LINKED1',
        from_user_id: 'PE.1128521366369305',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'hola' },
      },
      [
        {
          profile: { name: '𐹚𝓕𝓉𝒂𝓍𝒊𝒂꒱', username: 'thali.vd_' },
          user_id: 'PE.1128521366369305',
        },
      ],
    )

    // No second (BSUID-only) contact was created — the message resolved
    // straight to the one staff already linked.
    expect(h.state.contactsTable).toHaveLength(1)
    expect(h.state.contactsTable[0].id).toBe('contact-linked')
    expect(h.state.contactsTable[0].wa_user_id).toBe('PE.1128521366369305')
    // The real phone stays untouched — it's still the trusted one.
    expect(h.state.contactsTable[0].phone).toBe('+51912147223')
  })

  it('opportunistically captures a username seen alongside a real phone number', async () => {
    // Seeds the row the mocked findExistingContact "finds" for the
    // ordinary phone path (id: 'contact-1'), so the update call this
    // test asserts on lands somewhere observable.
    h.state.contactsTable.push({
      id: 'contact-1',
      phone: '15551230000',
      name: 'Ada',
      wa_username: null,
      wa_user_id: null,
    })

    await runWebhook(TEXT_MESSAGE, [
      {
        profile: { name: 'Ada', username: 'ada_w' },
        wa_id: '15551230000',
        user_id: 'PE.ADATOKEN',
      },
    ])

    const row = h.state.contactsTable.find((c) => c.id === 'contact-1')
    expect(row?.wa_username).toBe('ada_w')
    expect(row?.wa_user_id).toBe('PE.ADATOKEN')
  })
})

describe('inbound webhook: after() awaits automations (#368)', () => {
  it('every triggered automation settles before the after() callback resolves', async () => {
    await runWebhook()

    // first_inbound_message + new_message_received + keyword_match.
    expect(h.state.automationStarted).toBe(3)
    // If the dispatches were fire-and-forget, completed would still be 0
    // here — the callback would have resolved before the timers fired.
    expect(h.state.automationCompleted).toBe(3)
  })
})
